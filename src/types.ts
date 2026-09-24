export type Site = {
  NAME: string;
  EMAIL: string;
  NUM_POSTS_ON_HOMEPAGE: number;
};

export type Metadata = {
  TITLE: string;
  DESCRIPTION: string;
};

export type Socials = {
  NAME: string;
  HREF: string;
  // File name in src/assets/social, and the colour the icon turns on hover.
  ICON: string;
  BRAND: string;
}[];
