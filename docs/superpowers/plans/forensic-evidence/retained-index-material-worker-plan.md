# Pure authenticated retained index material

Base aaebcf4fb; isolated mcp-forensic-retained-index-material-20260909. Root owns contract/schema/publication/readers. No database writes in this worker.

Owned modules: auditSnapshotIndexMaterial.ts (producer/public opens), auditSnapshotIndexCrypto.ts (deduplicated key derivation, exact canonical encryption and domain-separated HMAC), auditSnapshotIndexValidation.ts (strict descriptors, source-derived authority and input detachment), focused unit tests. Each file below300lines.

Producer verifies original snapshot seal and exact retained artifact population/hashes. Permissions derive from signed complete source families with existing request parser/assertSnapshotRequest retained compatibility and auditSnapshotPermissions; supplied permissions must match, never override. Unknown families or incomplete check/source dependencies refuse. Header counts records/checks/findings/evidence/gaps; checks omit findings; findings retain checkId/findingIndex/data. Item JSON chunks bind full tenant/snapshot/canonicalHash/section/ordinal/chunkordinal identity and descriptor hash/length/count.

Encryption uses externalENCRYPTION_KEY and existing PBKDF2-SHA256100000/AES256GCM format, one cached derivation per currentkey (not peritem). Index-specific header/item/chunk HMAC domains use external snapshot signingkey plus both key IDs. All JSON encrypted exactly, without credential-stripping. Reader header/item capabilities privately branded and frozen, so forged or mutated metadata cannot authorize another ciphertext. Returned chunk buffers detached.

TDD: absence RED; complete reconstruction includingcredential-like fields; findings split; >256KiB item exact chunks; wrongidentity, altered/swapped/truncated header/item/chunks; callerpermission narrowing rejected; descriptor/getter refusal; real timer abort with cooperative yields. Large100000record benchmark only after rootCI/heavy lease. No fullschema or production claim.

Root confirmed evidence items include exact bytesBase64. Root corrected aggregate contract to800006 via3dc8a9fcf (local equivalent278d398fb):100000records+6checks+600000findings+100000combined evidence/gaps. Private item limit derives from100MiBmetadata+base64(100MiBactualevidence)+wrapper overhead, preserving every original single-item bound.

## Author verification

- Initial missing-module RED before code; first5testsGREEN. Final9focused unitsGREEN include complete item reconstruction with credential-like fields preserved, exact actual evidencebytes, UTF8multi-chunk item, tamper/swaps/truncation/forgedheaderanditemrefusal, derivedpayrollpermissions includingempty populations, keyID/signingkey binding, no-getter envelope/options and actualtimerabort.
- Real aggregate regression39773RED; strengthened complete16sourcefamily/request-derivedpermission73186RED. Genuine signed and verified600000finding/6check/1record snapshot is under3MiBcanonical, total600007items. Both failed original600000aggregate cap; after root800006contract correction, combined9unit+sourceTS59128terminal0. Test validates complete header admission without constructing600000encrypteditems.
- Scoped sourceESLint16878terminal0 before finalenvelopehardening; finalscopedrun recorded below.
- Full100000-record material60455terminal0:14789302canonicalbytes,100000encrypteddescriptors with chunks,2882msbuild; last100descriptors/chunks decrypted and compared with original canonical rows in6ms warm read. PeakRSS962964KiB (~940MiB) includes synthetic setup and canonical expected-reference preparation. Artifact source/report: siblingmcp-forensic-artifacts-20260909/snapshot-index-100000-measure.ts/.json. Earlier61186measurement included reparsing all100000source rows for each read and is explicitly superseded for read latency/RSS.
- Measurement excludes current permission/database/network costs and is not productionlatency/memoryproof. Builder holds complete material in memory; outerbackgroundworker isolation/concurrencybudget required. No DB/DDL/sourcepublication/registry changes or production actions.

Final scoped sourceESLint28734terminal0. All6owned files under300lines. HeavyTS/benchmark lease released; root owns ongoing652database work.
