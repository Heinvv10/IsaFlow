/**
 * GENERATED in production's image by tests/unit/printParity/packFallbackMarksImage.test.ts: do not edit by hand.
 * Regenerate (velo): REGENERATE_FALLBACK_MARKS=1 npx vitest run --config vitest.print.config.ts tests/unit/printParity/packFallbackMarksImage.test.ts
 *
 * Each combining mark of the dictionary-broken (SA) scripts: [code point, what it adds in a word (after a consonant of
 * its own script), what it adds anywhere else (after itself, or after a Latin letter)], in whole pixels at 12px, rounded
 * up, the larger of the regular and the semibold. `packFallbackWidthCore` reads it. 191 marks. Client-safe data.
 */
export const FALLBACK_MARKS: ReadonlyArray<readonly [number, number, number]> = [
  [0xe31, 0, 0], [0xe34, 0, 0], [0xe35, 0, 0], [0xe36, 0, 0], [0xe37, 0, 0], [0xe38, 0, 0], [0xe39, 0, 0], [0xe3a, 0, 0],
  [0xe47, 0, 0], [0xe48, 0, 0], [0xe49, 0, 0], [0xe4a, 0, 0], [0xe4b, 0, 0], [0xe4c, 0, 0], [0xe4d, 0, 0], [0xe4e, 0, 0],
  [0xeb1, 0, 0], [0xeb4, 0, 0], [0xeb5, 0, 0], [0xeb6, 0, 0], [0xeb7, 0, 0], [0xeb8, 0, 0], [0xeb9, 0, 0], [0xeba, 4, 6],
  [0xebb, 0, 0], [0xebc, 0, 0], [0xec8, 0, 0], [0xec9, 0, 0], [0xeca, 0, 0], [0xecb, 0, 0], [0xecc, 0, 0], [0xecd, 0, 0],
  [0xece, 4, 6], [0x102b, 4, 11], [0x102c, 6, 13], [0x102d, 0, 8], [0x102e, 0, 8], [0x102f, 0, 8], [0x1030, 0, 8], [0x1031, 8, 15],
  [0x1032, 0, 8], [0x1033, 0, 8], [0x1034, 0, 8], [0x1035, 0, 8], [0x1036, 0, 8], [0x1037, 0, 8], [0x1038, 5, 12], [0x1039, 0, 8],
  [0x103a, 0, 8], [0x103b, 4, 11], [0x103c, 3, 10], [0x103d, 0, 8], [0x103e, 0, 8], [0x1056, 5, 12], [0x1057, 5, 12], [0x1058, 0, 8],
  [0x1059, 0, 8], [0x105e, 0, 8], [0x105f, 0, 8], [0x1060, 0, 8], [0x1062, 5, 12], [0x1063, 8, 16], [0x1064, 5, 12], [0x1067, 6, 13],
  [0x1068, 5, 12], [0x1069, 6, 13], [0x106a, 6, 13], [0x106b, 6, 13], [0x106c, 6, 13], [0x106d, 6, 13], [0x1071, 0, 8], [0x1072, 0, 8],
  [0x1073, 0, 8], [0x1074, 0, 8], [0x1082, 0, 8], [0x1083, 5, 12], [0x1084, 8, 15], [0x1085, 0, 8], [0x1086, 0, 8], [0x1087, 5, 12],
  [0x1088, 5, 12], [0x1089, 5, 12], [0x108a, 6, 13], [0x108b, 5, 12], [0x108c, 8, 15], [0x108d, 0, 8], [0x108f, 5, 12], [0x109a, 5, 12],
  [0x109b, 5, 12], [0x109c, 6, 13], [0x109d, 0, 8], [0x17b4, 0, 0], [0x17b5, 0, 0], [0x17b6, 4, 12], [0x17b7, 0, 8], [0x17b8, 0, 8],
  [0x17b9, 0, 8], [0x17ba, 0, 8], [0x17bb, 0, 8], [0x17bc, 0, 8], [0x17bd, 0, 8], [0x17be, 4, 12], [0x17bf, 7, 15], [0x17c0, 7, 15],
  [0x17c1, 4, 12], [0x17c2, 4, 12], [0x17c3, 4, 12], [0x17c4, 7, 15], [0x17c5, 7, 15], [0x17c6, 0, 8], [0x17c7, 5, 13], [0x17c8, 4, 12],
  [0x17c9, 0, 8], [0x17ca, 0, 8], [0x17cb, 0, 8], [0x17cc, 0, 8], [0x17cd, 0, 8], [0x17ce, 0, 8], [0x17cf, 0, 8], [0x17d0, 0, 8],
  [0x17d1, 0, 8], [0x17d2, 0, 8], [0x17d3, 0, 8], [0x17dd, 0, 8], [0x1a55, 3, 4], [0x1a56, 0, 0], [0x1a57, 4, 4], [0x1a58, 0, 0],
  [0x1a59, 0, 0], [0x1a5a, 0, 0], [0x1a5b, 0, 0], [0x1a5c, 0, 0], [0x1a5d, 0, 0], [0x1a5e, 0, 0], [0x1a60, 0, 0], [0x1a61, 6, 6],
  [0x1a62, 0, 0], [0x1a63, 7, 7], [0x1a64, 4, 4], [0x1a65, 0, 0], [0x1a66, 0, 0], [0x1a67, 0, 0], [0x1a68, 0, 0], [0x1a69, 0, 0],
  [0x1a6a, 0, 0], [0x1a6b, 0, 0], [0x1a6c, 0, 0], [0x1a6d, 4, 4], [0x1a6e, 7, 8], [0x1a6f, 14, 15], [0x1a70, 7, 8], [0x1a71, 7, 8],
  [0x1a72, 7, 8], [0x1a73, 0, 0], [0x1a74, 0, 0], [0x1a75, 0, 0], [0x1a76, 0, 0], [0x1a77, 0, 0], [0x1a78, 0, 0], [0x1a79, 0, 0],
  [0x1a7a, 0, 0], [0x1a7b, 0, 0], [0x1a7c, 0, 0], [0xa9e5, 0, 8], [0xaa7b, 5, 12], [0xaa7c, 0, 8], [0xaa7d, 8, 15], [0xaab0, 0, 8],
  [0xaab2, 0, 8], [0xaab3, 0, 8], [0xaab4, 0, 8], [0xaab7, 0, 8], [0xaab8, 0, 8], [0xaabe, 0, 8], [0xaabf, 0, 8], [0xaac1, 0, 8],
  [0x1171d, 0, 8], [0x1171e, 3, 11], [0x1171f, 0, 8], [0x11720, 4, 11], [0x11721, 4, 11], [0x11722, 3, 10], [0x11723, 3, 10], [0x11724, 0, 8],
  [0x11725, 0, 8], [0x11726, 8, 15], [0x11727, 3, 10], [0x11728, 0, 8], [0x11729, 3, 10], [0x1172a, 0, 8], [0x1172b, 0, 8],
];
