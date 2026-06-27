import type { Site, Metadata, Socials } from "@types";

export const SITE: Site = {
  NAME: "Dheeraj's blog",
  EMAIL: "dheerajsaivnr@gmail.com",
  NUM_POSTS_ON_HOMEPAGE: 5,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION:
    "Dheeraj's blog — notes on the things I build and figure out along the way.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION:
    "Writing about software I build — architecture, the tricky parts, and what I learned.",
};

export const SOCIALS: Socials = [
  {
    NAME: "github",
    HREF: "https://github.com/dheerajsai15",
  },
  {
    NAME: "linkedin",
    HREF: "https://www.linkedin.com/in/dheeraj-sai-60586a1b4/",
  },
];
