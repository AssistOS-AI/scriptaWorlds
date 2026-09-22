# Continuity review protocol

This protocol operationalizes CCI and CAD from `private/metricx.docx`, M0085 through M0086 and M0116 through M0117. Source SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`. Numerical procedures belong to the metrics registry; the steps here are project proposals.

## Review order

1. Load the packet and let the shared validation refuse it before reviewing anything: the manifest, the schema version, the declared scope, every file's path, encoding, byte count and hash, and the recomputed content identity of the accepted version. Record the accepted version and the scope actually covered; a scope that declares an omission is not a whole-book review.
2. Check file-level facts mechanically: chapter numbering, chapter references field by field (accepted occurrences must exist, deadlines and blueprint destinations may point forward), collection types, unique identifiers and evidence boundaries. An invalid container yields a structured finding before iteration.
3. Build a small list of claims relevant to the requested scope. Keep the selection method and the reviewed population visible.
4. Retrieve earlier and later passages for suspected changes. Look for intervening causes, elapsed time, different objects, false testimony or a change in focalization.
5. Record each finding as confirmed, unresolved or dismissed with an alternative explanation, its paired earlier and later evidence, and its temporal scope. Link duplicate symptoms of the same underlying defect with one comparison id so they add a single penalty.
6. Derive the counts, the coverage and the indices from those records, and produce the result bundle without changing any source. Verify source hashes after the run. A host may publish only the validated output from the isolated result directory.

## Questions for a suspected contradiction

Are both passages about the same entity and the same time? Is the earlier statement a permanent property, a current condition or someone's belief? Does the later action require knowledge or ability the character has not acquired? Does an intervening accepted scene explain the change? Is the narrator intentionally unreliable, and is there textual support for that reading?

An illiterate child copying a visible symbol differs from writing an unseen verbal sentence. A fully open valve later opening by a quarter turn requires either an intervening adjustment or a different valve. A character exaggerating their fear of being alone differs from an omniscient factual assertion about everyone's lifespan. The reviewer should identify the missing distinction before proposing a repair.

## Severity and certainty

Integrity errors concern whether the input can be trusted. A major semantic finding undermines a central causal chain or permanent rule. A local semantic finding affects a limited passage or detail. An editorial observation concerns clarity without establishing a contradiction. These categories do not replace confidence.

Use confidence based on evidence availability and alternative explanations. An exact invalid reference can have deterministic certainty. A plausible motivational inconsistency may remain tentative. Suspected semantic errors are advisory until the acceptance policy defines a narrower, reviewable gate. Do not make a model's high confidence sufficient to block publication.

## CCI and CAD handoff

Supply the metrics layer with the packet version, the covered scope, the reviewed comparison records and their outcomes, the findings, the derived counts and coverage, and the exclusions. CCI concerns consistency in the reviewed facts and events. CAD concerns unsupported attribute changes among actual change candidates. A character with no observed change has no eligible CAD denominator; the derived index is then `not_applicable` rather than an ideal score, and an index that no comparison could settle is reported with bounds or withheld instead of being rounded to a perfect one.

Report coverage, including the number of chapters examined, the selected comparisons and the unresolved cases. A review of the last two chapters cannot claim to assess the whole book unless it also checked all relevant earlier evidence, and a declared omission is a limitation of the result rather than a clean bill of health.

## Repair suggestions

Suggest the smallest change that resolves the defect while preserving the intended scene: clarify copying, establish an intervening adjustment, narrow an exaggerated factual claim or correct an obsolete current-state summary. Present alternatives where the intended meaning is unclear. ALA or a human chooses and writes any revision through the normal transaction.
