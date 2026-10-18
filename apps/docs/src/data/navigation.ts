export interface NavigationItem {
  href: string;
  label: string;
  status?: "wip";
}

export interface NavigationSection {
  label?: string;
  items: NavigationItem[];
}

export const navigation: NavigationSection[] = [
  {
    label: "Start",
    items: [
      { href: "/introduction", label: "Introduction" },
      { href: "/docs/getting-started", label: "Getting started" },
    ],
  },
  {
    label: "Concepts",
    items: [
      { href: "/docs/concepts/capability", label: "Capabilities" },
      { href: "/docs/concepts/outcomes", label: "Outcomes" },
      { href: "/docs/concepts/idempotency", label: "Idempotency" },
      { href: "/docs/concepts/stores", label: "Stores" },
      { href: "/docs/concepts/cancellation", label: "Cancellation" },
    ],
  },
  {
    label: "Reference",
    items: [
      { href: "/docs/reference/api", label: "API reference" },
      { href: "/docs/reference/refund-example", label: "Refund example" },
    ],
  },
  {
    label: "Help",
    items: [{ href: "/docs/troubleshooting", label: "Troubleshooting" }],
  },
];

export const navigationItems = navigation.flatMap((section) => section.items);
