---
title: "Anatomy of an PR review agent on LangGraph.js"
description: "A node-by-node walkthrough of a GitHub PR review agent built as a LangGraph.js StateGraph — the shared state, every node's job, the parallel fan-out, the human gate, and the CLI that drives it all."
date: "Jun 27 2026"
---

I built an code-review agent for GitHub pull requests on [LangGraph.js](https://langchain-ai.github.io/langgraphjs/). You give it a PR URL; it fetches the diff, reviews each changed file with an LLM **in parallel**, pauses for a human to approve, and posts a single summary comment back to the PR.

This post takes it apart: the graph, each node and what it actually does, how the CLI drives the whole thing, and the durable pause that lets a run be resumed days later from a different machine.

## Why a graph instead of a function?

You could write this as one `async` function with a `for` loop. Three requirements push you toward a graph runtime instead:

1. **Parallelism with a join.** Each file is reviewed independently, then results must be merged before summarising — a fan-out followed by a barrier.
2. **Human-in-the-loop.** The run has to *pause* at an approval step and resume later, possibly in another process. That needs durable state, not a stack frame.
3. **Resumability.** If the machine dies mid-review, you don't want to re-pay for the LLM calls already made.

A graph runtime hands you fan-out/join, interrupts, and checkpointing as primitives. That's the whole reason it's here.

## The graph at a glance

Five nodes, two conditional edges, three terminal outcomes (**skipped**, **aborted**, **posted**):

<pre class="mermaid">
flowchart TD
  START([START]) --> ingest[ingest<br/>fetch changed files]
  ingest -->|routeAfterTriage| TRI{any reviewable<br/>files?}
  TRI -->|no| SKIP([END · SKIPPED])
  TRI -->|"yes — Send one per file"| review[review<br/>LLM, one file each]
  review --> aggregate[aggregate<br/>filter · rank · render]
  aggregate --> humanGate{humanGate<br/>interrupt · await human}
  humanGate -->|routeAfterGate: approve| post[post<br/>comment to PR]
  humanGate -->|routeAfterGate: abort| ABORT([END · ABORTED])
  post --> POSTED([END · POSTED])
</pre>

And the wiring that produces it:

```ts
export function buildGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(State)
    .addNode("ingest", ingest)
    .addNode("review", review)        // fan-out target
    .addNode("aggregate", aggregate)
    .addNode("humanGate", humanGate)  // interrupt lives here
    .addNode("post", post)
    .addEdge(START, "ingest")
    .addConditionalEdges("ingest", routeAfterTriage, { review: "review", skip: END })
    .addEdge("review", "aggregate")   // fan-in; concat reducer merges branches
    .addEdge("aggregate", "humanGate")
    .addConditionalEdges("humanGate", routeAfterGate, { approve: "post", abort: END })
    .addEdge("post", END)
    .compile({ checkpointer });       // REQUIRED — the interrupt needs it
}
```

## The shared state

In LangGraph, nodes don't pass arguments to each other — they read and write a shared **state** object. You declare it once with channels and, where needed, **reducers** that say how concurrent writes merge.

```ts
export const State = Annotation.Root({
  pr: Annotation<PrMeta>(),          // owner, repo, number, sha, author, title
  files: Annotation<FileDiff[]>(),   // changed files, after ingest

  // N parallel review branches write here. The reducer is LOAD-BEARING: the
  // default is last-write-wins, which would keep one file's findings and drop
  // the rest. concat merges every branch instead.
  fileReviews: Annotation<Finding[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),

  comments: Annotation<Finding[]>(),  // aggregated + ranked (final set)
  summaryBody: Annotation<string>(),  // rendered markdown comment body
  approved: Annotation<boolean>(),    // set by the human gate

  usage: Annotation<Usage>({          // tokens + cost, SUMMED across branches
    reducer: sumUsage,
    default: emptyUsage,
  }),
});
```

The two reducer channels are the ones that matter. `fileReviews` uses `concat` and `usage` uses `sumUsage` — both accumulate across the parallel `review` branches. Everything else is plain "last write wins."

## The nodes, one at a time

Each node is a function that reads the state and returns a `Partial<State>`. LangGraph merges that partial back through the channel reducers.

### 1. `ingest` — fetch the diff

```ts
export async function ingest(state: StateType): Promise<Partial<StateType>> {
  const pr = state.pr; // full metadata, already seeded by the CLI
  const files = useRealGitHub() ? await fetchChangedFiles(pr) : mockFetchFiles();
  return { files };
}
```

`ingest` is a thin I/O node. The CLI has *already* resolved the full PR metadata (and used it to build the run's `thread_id`), so `ingest` only fetches the changed files — via Octokit `pulls.listFiles` when a `GITHUB_TOKEN` is set, otherwise a deterministic mock. A flag (`USE_GITHUB`) decides which, so the whole graph can run offline. It writes `files`.

### 2. `routeAfterTriage` — triage, then fan out

Between `ingest` and `review` sits a conditional edge. This is where **triage** happens — deterministically, with no LLM:

```ts
export function routeAfterTriage(state: StateType): "skip" | Send[] {
  const reviewable = (state.files ?? []).filter(isReviewable);
  if (reviewable.length === 0) return "skip";                 // -> END
  return reviewable.map((file) => new Send("review", { file })); // -> N parallel reviews
}
```

`isReviewable` drops the files an LLM shouldn't waste tokens on: deletions, binary files (no patch), lockfiles (`package-lock.json`, `yarn.lock`, …), generated paths (`/dist/`, `/build/`, `/node_modules/`, …), minified/asset extensions (`.min.js`, `.map`, `.png`, …), and oversized diffs (> 1500 changed lines).

If nothing survives, it returns `"skip"` and the run ends with **SKIPPED**. Otherwise it returns an array of `Send` objects — and that's the fan-out. Each `new Send("review", { file })` schedules one run of the `review` node with *that one file* as its payload. N files → N parallel `review` invocations, and N isn't known until runtime.

> **A gotcha worth flagging.** The `{ review: "review" }` map in `addConditionalEdges` looks like documentation, but it's load-bearing. The `ingest → review` edge only exists dynamically via `Send`, and LangGraph's compile-time reachability check can't see dynamic edges. Remove the map entry and the graph won't compile: *"Node 'review' is not reachable."*

### 3. `review` — the only LLM node

```ts
export async function review(payload: { file: FileDiff }): Promise<Partial<StateType>> {
  const { file } = payload;
  try {
    const { findings, usage } = await reviewFile(file);
    return { fileReviews: findings, usage };
  } catch (err) {
    // One file's failure must not crash the whole superstep.
    return { fileReviews: [] };
  }
}
```

Note the input: `review` receives `{ file }`, **not** the whole state. Each branch sees exactly its one file. It calls the model (OpenAI structured output for typed `Finding[]`, or an offline stub) and returns its findings plus token usage — both targeting reducer channels, which is how the parallel branches merge on fan-in.

The `try/catch` is deliberate. Because all `review` branches share a barrier (the next node waits for *every* one), an unhandled throw in a single branch would fail the whole superstep and lose the other files' work. Catching it and returning zero findings keeps the run alive — a degraded review beats a dropped one.

### 4. `aggregate` — filter, rank, render

```ts
export async function aggregate(state: StateType): Promise<Partial<StateType>> {
  const kept = (state.fileReviews ?? [])
    .filter((f) => (f.confidence ?? 1) >= 0.5);   // precision over recall
  kept.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.file.localeCompare(b.file));
  const summaryBody = renderSummary(kept, state);
  return { comments: kept, summaryBody };
}
```

Another deterministic, no-LLM node. It reads the merged `fileReviews` from all branches, drops low-confidence noise, sorts by severity (`blocker → major → minor → nit`) then file, and renders one markdown comment body grouped by file with a severity count line. It writes `comments` (the final findings) and `summaryBody` (what the human will see and what gets posted).

### 5. `humanGate` — pause for a human

```ts
export function humanGate(state: StateType): Partial<StateType> {
  const decision = interrupt({ summaryBody: state.summaryBody, comments: state.comments });
  return { approved: decision === "approve" };
}
```

The whole node is one `interrupt()`. It **checkpoints the state and halts the run**, handing the drafted summary back to whoever called `invoke()`. When the run is later resumed with a decision, `interrupt()` *returns* that value and execution continues from this exact line. Nothing reaches GitHub before this gate clears — and because the state is checkpointed, the pause survives the process dying. (This is why `.compile()` requires a checkpointer.)

`routeAfterGate` then reads the decision: `state.approved ? "approve" : "abort"`.

### 6. `post` — submit the comment

```ts
export async function post(state: StateType): Promise<Partial<StateType>> {
  await getPublisher().postReview(state.pr, state.summaryBody);
  return {};
}
```

Only reached on approval. It posts the single summary comment (Octokit `pulls.createReview` behind a `PrPublisher` interface, or a mock), and the run ends with **POSTED**.

## How execution actually flows: supersteps

Is `aggregate` guaranteed to run *once*, after *every* `review` finishes? Yes — and it's a property of the runtime, not something you arrange by hand. LangGraph executes in **supersteps**, the [BSP (Bulk Synchronous Parallel)](https://en.wikipedia.org/wiki/Bulk_synchronous_parallel) model — the same idea as Google's Pregel:

1. **Compute** — run all nodes scheduled for this step, in parallel.
2. **Barrier** — wait for *every* one to finish.
3. **Merge** — apply their writes through the reducers.
4. Schedule the next step from the resulting edges.

So all the `review` Sends run in one superstep. The next step can't begin until the barrier clears — until every branch has returned and its writes are reduced into `fileReviews`. Only then does `review → aggregate` fire, and because all branches point at the *same* node, `aggregate` is scheduled once, seeing the fully-merged findings.

<pre class="mermaid">
flowchart LR
  subgraph S1["Superstep 1"]
    i[ingest]
  end
  subgraph S2["Superstep 2 — parallel"]
    a[review A]
    b[review B]
    c[review C]
  end
  subgraph BAR["⟂ barrier + reduce"]
    m["fileReviews = A ++ B ++ C<br/>usage = A + B + C"]
  end
  subgraph S3["Superstep 3"]
    ag[aggregate · runs once]
  end
  S1 --> S2 --> BAR --> S3
</pre>

The fan-out is `Send`; the fan-in is the reducer. Two halves of one mechanism — and you never write "wait for all reviews" logic, because the barrier *is* the model.

## The CLI: driving the graph

The graph is the engine; the CLI is the driver. It has two commands, `review` and `resume`, and both converge on the same gate-handling logic.

<pre class="mermaid">
sequenceDiagram
  participant U as User
  participant CLI
  participant G as Graph
  participant DB as Checkpointer

  U->>CLI: review &lt;pr-url&gt;
  CLI->>CLI: parsePrUrl + resolve PR meta (sha)
  Note over CLI: thread_id = owner/repo#num:sha
  CLI->>G: invoke({ pr }, { thread_id })
  G->>G: ingest → triage → review×N → aggregate
  G->>DB: checkpoint state at humanGate
  G-->>CLI: interrupt(summaryBody)
  CLI->>U: print drafted review, prompt y/N
  U->>CLI: approve
  CLI->>G: invoke(Command resume=approve)
  G->>G: post comment
  G-->>CLI: done → Outcome: POSTED
</pre>

### `review <pr-url> [--approve|--abort]`

```ts
const ref = parsePrUrl(url);                 // owner/repo/number from the URL
const pr  = await fetchPrMeta(ref);          // full meta incl. head sha
const tid = threadId(ref, pr.sha);           // "owner/repo#42:abc1234"
const config = { configurable: { thread_id: tid } };

const app = buildGraph(await getCheckpointer());
await app.invoke({ pr }, config);            // runs up to interrupt(), then returns
await handleGate(app, config, tid, decisionFlag);
```

It parses the URL, resolves full PR metadata once (which also validates access), and computes the `thread_id`. Then it builds the graph and invokes it — which runs `ingest → … → humanGate` and *returns at the interrupt*. From there `handleGate` takes over.

### The gate handler (shared by both commands)

```ts
let snap = await app.getState(config);
const pending = pendingInterrupt(snap);      // dig the interrupt value out of the snapshot
if (!pending) { reportOutcome(snap); return; } // already skipped/aborted/posted

printFindings(pending);                       // show the drafted review

const decision = decisionFlag ?? (await promptDecision());  // flag, or interactive y/N
if (decision === null) {                       // non-tty and no flag -> leave it paused
  console.log(`Resume later with: npm run resume -- ${tid} --approve`);
  return;
}
await app.invoke(new Command({ resume: decision }), config); // continue past the gate
reportOutcome(await app.getState(config));     // POSTED / ABORTED / SKIPPED + token usage
```

`Command({ resume: value })` is the counterpart to `interrupt()`: it re-enters the suspended node, and `interrupt()` returns `value`. If the prompt can't run (non-interactive shell) and no `--approve/--abort` flag was given, the run is simply **left parked** in the checkpointer with a printed resume command.

### `resume <thread-id> [--approve|--abort]`

```ts
const app = buildGraph(await getCheckpointer());
const snap = await app.getState(config);       // load state by thread_id
if (!snap.createdAt) { /* no checkpoint found */ }
await handleGate(app, config, tid, decisionFlag);
```

This is the durability payoff. Because the state lives in Postgres keyed by `thread_id`, `resume` can pick up a parked run **from a completely different process or machine** — it loads the checkpoint, confirms it's real, and runs the same gate handler.

### Why `thread_id = prId:sha`

The `thread_id` is the identity of a run, and the choice of key is deliberate:

- The **PR id** (`owner/repo#number`) scopes the run to one pull request.
- The **head SHA** scopes it to one *version* of that PR. Push new commits and the SHA changes, so it's a new thread — a fresh review, not a stale resume of an old diff.

Re-running the same PR at the same commit resumes; re-running after a push starts over. Exactly the granularity you want.

## Where this goes next

What I've described is the engine. To run it as a real service that watches a busy repo, three things need to change.

### From a user token to a GitHub App

Today `ingest` and `post` authenticate with a personal `GITHUB_TOKEN`. That's fine for a CLI you run yourself, but it means every comment is posted as *me*, the token carries my full account scope, and rate limits are shared across everything I do.

A [GitHub App](https://docs.github.com/en/apps) is the right identity for a bot:

- It comments as its own entity ("PR Review Bot"), not a human.
- Permissions are scoped to exactly what it needs — read PR contents, write PR comments — and granted per-repo at install time.
- It authenticates per *installation*: a short-lived JWT signed with the app's private key is exchanged for an installation token, which carries its own, higher rate limit per repo.
- It can subscribe to **webhooks**, so instead of me running `review <url>`, GitHub pushes a `pull_request` event the moment a PR opens or gets new commits.

That last point flips the whole trigger model: the CLI's `parsePrUrl → fetchPrMeta` becomes a webhook handler that reads `owner/repo/number/sha` straight off the event payload and kicks off the graph. The `thread_id = prId:sha` key already fits this perfectly — a `synchronize` event (new commits) naturally becomes a new thread.

### Handling context: give the agent the whole repo, not a diff

The `review` node currently sees one file's diff in isolation. A diff hunk with no surrounding code is a thin thing to reason about — the model can't see the function it's halfway inside, the type being passed in, or the caller three files over. That produces confident-but-wrong findings, the exact noise the confidence filter is trying to suppress.

The instinct is to *feed* the model more context: expand the hunk, attach the file's imports, build an embeddings index and retrieve the few snippets that look relevant. That works, but it's all *guessing in advance* what a reviewer will need, and it keeps the model passive — it can only reason over whatever you decided to paste in.

I think the better answer is to stop pre-fetching context and instead **give the agent a real checkout it can explore itself.** Spin up a fresh [microVM](https://github.com/firecracker-microvm/firecracker) per review, `git fetch` the PR's head SHA, and hand the model a set of tools over that filesystem:

- `grep`/`ripgrep` to find callers and definitions,
- "read file" to open any neighbour, not just the changed ones,
- the project's own **build, type checker, and linter** — whatever the repo actually uses — to see what the change breaks,
- optionally the **test suite**, so a finding can be *confirmed* rather than guessed.

This turns `review` from "summarise a diff" into a small agentic loop: the model decides what it needs to look at, pulls it, and reasons over ground truth. Context stops being something I prepare and becomes something the agent gathers on demand — which is exactly how a human reviewer works.

The reason it has to be a **microVM** and not just a temp directory is trust. A PR is untrusted code, and the moment you run its build or tests you're executing it. A microVM gives you a real kernel boundary, a disposable filesystem, no network (or a tightly scoped one), and a hard CPU/memory/time budget — then you throw the whole thing away when the review finishes. A checkout keyed by the same `prId:sha` even maps cleanly onto the existing `thread_id`.

The cost is real — booting a VM and running a build is far heavier than pasting a diff into a prompt — which is exactly why it pairs with the next concern: you only want to pay for a full checkout-and-build on a PR that's actually still live.

#### This reshapes the graph

A checkout isn't a free upgrade to the `review` node — it changes the shape of the graph, because it breaks two assumptions the current design quietly relies on.

The first is that **each `review` branch is fully self-contained.** With `Send("review", { file })`, the obvious implementation gives every branch its own everything. But the microVM is a per-*run* resource: booting it, fetching the repo, and running a build are wildly expensive to do N times for the same PR. So the workspace has to be created **once per run** and *shared* by the branches:

```
ingest → setup     (boot microVM · git fetch sha · build once)
       → review×N  (fan-out; branches share the read-only checkout)
       → aggregate
       → teardown  (destroy the VM — on every exit path)
```

- **Building is a per-run, project-wide operation, not a per-file one.** Whatever the repo's toolchain is — a compiler, a type checker, a linter, across whatever languages the PR touches — it runs over the project, once, in `setup`. Its output becomes shared state that every `review` branch reads, instead of N branches each re-running it.
- **The fan-out survives, but only as a parallelism dial.** Branches still review in parallel, they just share the one checkout rather than owning a VM each. Concurrent *reads* — grep, open a neighbouring file — are safe, and that's most of what a review actually does.
- **Teardown has to be guaranteed.** The graph has three terminal outcomes (skipped, aborted, posted); a VM that leaks on the abort path is a real bug. Cleanup can't hang off the happy-path `post` node — it needs to run however the graph exits.

The second assumption that breaks is that **a `review` branch owns its context.** Once the whole point is cross-file reasoning, a branch that can only see its one file is fighting the feature you built the VM for. The file becomes the unit you *attribute findings to*, not the boundary of what a branch is allowed to look at.

None of this is a reason not to do it — it's the honest cost. The per-file fan-out was the right call for stateless diff-summary branches. A shared, stateful, expensive workspace is a different problem, and the graph has to grow to match it.

### Queues: decoupling the trigger from the work

Once a webhook fires the graph instead of a human, the work needs somewhere to live. A review is slow (N parallel LLM calls) and bursty (ten PRs can land in a minute). You can't do that synchronously inside a webhook handler — GitHub wants a `2xx` in seconds, and a crash mid-handler loses the event.

The fix is a **queue** between the webhook and the graph:

1. The webhook handler does almost nothing — validate the signature, enqueue a job (`{ owner, repo, number, sha }`), return `200` immediately.
2. A pool of **workers** pulls jobs and runs the graph. Concurrency is now a dial you control, which keeps you under the API rate limit and bounds LLM spend.
3. **Retries and idempotency** come from the queue: a failed job is redelivered, and because the `thread_id` is deterministic (`prId:sha`), re-processing the same event resumes the existing run instead of starting a duplicate.
4. **Superseding:** when new commits arrive, you can cancel the in-flight job for the old SHA — no point finishing a review of a diff nobody will look at.

Notice the queue sits *outside* the graph and the graph's own checkpointer sits *inside* it. They solve different problems: the queue distributes and retries whole runs across workers; the checkpointer makes a single run durable and resumable. Together they're what turns this from a script I run into a service that runs itself.

## What I'd take away

The interesting parts here weren't the LLM calls — there's only one LLM node, and it's the simplest. The substance is in the wiring: a shared state with reducers, a dynamic `Send` fan-out joined by a superstep barrier, a one-line `interrupt()` made durable by a checkpointer, and a CLI thin enough to be obvious — parse, invoke to the gate, resume. Deterministic code does the triage and aggregation where an LLM would only add noise.
