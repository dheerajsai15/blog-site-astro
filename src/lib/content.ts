import { getCollection, type CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"blog">;
export type SeriesEntry = CollectionEntry<"series">;

export type Series = {
  entry: SeriesEntry;
  parts: Post[];
};

export async function getPosts(): Promise<Post[]> {
  return (await getCollection("blog"))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

// Every series with its published parts in order, most recently updated first.
// Throws at build time if a post points at a series file that doesn't exist.
export async function getSeries(posts?: Post[]): Promise<Series[]> {
  const all = await getCollection("series");
  const published = posts ?? (await getPosts());

  for (const post of published) {
    const { series, part } = post.data;
    if (!series) continue;
    if (!all.some((s) => s.slug === series)) {
      throw new Error(`Post "${post.slug}" is in series "${series}", but src/content/series/${series}.md doesn't exist.`);
    }
    if (part === undefined) {
      throw new Error(`Post "${post.slug}" is in series "${series}" but has no part number.`);
    }
  }

  return all
    .map((entry) => ({
      entry,
      parts: published
        .filter((post) => post.data.series === entry.slug)
        .sort((a, b) => (a.data.part ?? 0) - (b.data.part ?? 0)),
    }))
    .filter((s) => s.parts.length > 0)
    .sort((a, b) => latest(b).valueOf() - latest(a).valueOf());
}

function latest(series: Series): Date {
  return new Date(Math.max(...series.parts.map((p) => p.data.date.valueOf())));
}

export function postUrl(post: Post): string {
  return `/blog/${post.slug}`;
}

export function seriesUrl(series: Series): string {
  return `/series/${series.entry.slug}`;
}

export function partLabel(post: Post): string {
  return post.data.short ?? `Part ${post.data.part}`;
}
