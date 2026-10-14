---
name: validate-analytical-method
description: Check metrics, denominators, population, computation method and completeness before presenting analytical claims.
manifest: {"schemaVersion":1,"version":"1.0.1","profiles":["browser-javascript"],"requires":["computation.validate"],"supportingFiles":[]}
---

# Validate analytical method

1. Resolve metric, aggregation, filters/time, grouping, ordering, population and required evidence roles from the current request and actual columns. Clarify unresolved scope; descriptive filter text is not a typed predicate.
2. Execute fresh data_query or code_run on complete current inputs. A truncated table cannot supply an overall denominator, global rank or complete-list claim.
3. For a computation state its formula, unit, missing/zero policy, population and complete coverage. Use computation_validate for the exact code receipt and supported method. Unsupported method blocks accepted factual output.
4. Bind multiple inputs to explicit roles and current versions. Zero rows are valid evidence; old cards and provider numbers are not current evidence.
5. Report the host-admitted result and query/computation reference. Method explanations may remain conversational, but dataset facts need current admitted evidence.
6. Lower weighted median uses the current fixed value/weight/unit/filter scope and nonnegative integer frequencies. Choose the first ascending observed value reaching half the total weight; exact-half ties select the lower value. Do not interpolate or average. Missing pairs and zero-weight rows are accounted for separately. Mixed units, negative/fractional weights and unsafe totals block admission.
