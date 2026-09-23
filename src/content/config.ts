import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().optional(),
    // Optional: put a post in a series. `series` is a file name in src/content/series.
    series: z.string().optional(),
    part: z.number().int().positive().optional(),
    // Short label for the series progress bar, e.g. "Argo CD". Falls back to "Part N".
    short: z.string().optional(),
  }),
});

const series = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    status: z.enum(["ongoing", "complete"]).default("ongoing"),
  }),
});

export const collections = { blog, series };
