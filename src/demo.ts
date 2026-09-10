import type { Dataset, Profile } from "./types.ts";

export function demoDataset(): Dataset {
  const now = new Date().toISOString();
  const people: Array<[string, string, number | null, boolean]> = [
    ["sofia.example", "Sofia Rossi", 842, true],
    ["marco.example", "Marco Bianchi", 1250, true],
    ["elena.example", "Elena Moretti", 674, true],
    ["luca.example", "Luca Ricci", 921, true],
    ["giulia.example", "Giulia Conti", 1104, true],
    ["andrea.example", "Andrea Romano", 387, true],
    ["nina.example", "Nina Ferri", 2350, true],
    ["davide.example", "Davide Costa", 562, true],
    ["alice.example", "Alice Marino", 1432, false],
    ["pietro.example", "Pietro Leone", 730, false],
    ["studio.example", "The Everyday Studio", 124800, false],
    ["fieldnotes.example", "Field Notes", 81600, false],
    ["travel.example", "Somewhere Else", 1200000, false],
    ["design.example", "Objects & Things", 23400, false],
    ["francesca.example", "Francesca Riva", null, false],
    ["cafe.example", "Caffè del Sabato", 4180, false],
    ["boundary.example", "Twenty Thousand", 20000, false],
    ["marta.example", "Marta Galli", 981, false],
  ];
  const profiles: Record<string, Profile> = Object.create(null) as Record<string, Profile>;
  for (const [username, displayName, count] of people) {
    profiles[username] = { username, displayName, ...(count === null ? {} : {
      followerCount: { value: count, exact: true, observedAt: now, source: "manual" as const },
    }) };
  }
  const owner = "your.circle";
  profiles[owner] = { username: owner, displayName: "Your circle" };
  const following = people.map(([username]) => username);
  const followers = people.filter(([, , , mutual]) => mutual).map(([username]) => username);
  return {
    schemaVersion: 1, owner, importedAt: now, snapshotAt: now,
    followersComplete: true, followingComplete: true, followers, following, profiles,
    edges: [
      ...following.map((to) => ({ from: owner, to, source: "export" as const, observedAt: now })),
      ...followers.map((from) => ({ from, to: owner, source: "export" as const, observedAt: now })),
      ...[
        ["sofia.example", "alice.example"], ["marco.example", "alice.example"],
        ["elena.example", "alice.example"], ["sofia.example", "pietro.example"],
        ["luca.example", "pietro.example"], ["giulia.example", "marta.example"],
        ["luca.example", "cafe.example"], ["marco.example", "studio.example"],
        ["sofia.example", "elena.example"], ["marco.example", "luca.example"],
        ["elena.example", "giulia.example"],
      ].map(([from, to]) => ({ from: from!, to: to!, source: "manual" as const, observedAt: now, evidence: "Illustrative demo connection" })),
    ],
    friends: followers.slice(0, 5),
    decisions: {}, queue: [], threshold: 20000, demo: true,
  };
}
