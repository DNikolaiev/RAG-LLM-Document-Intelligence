# Pharmacy supplier domain pack

Version `1.0.0` configures the CaseLens demo for qualification of a pharmaceutical supplier. The executable source of truth is the schema-validated `pharmacySupplierPack` exported by `@caselens/domain`; `pack.summary.json` is a portable catalog for administrators and fixture tooling.

The fixture intentionally omits a GDP certificate, sets liability coverage to EUR 1,000,000 against a EUR 2,000,000 requirement, and uses a conflicting contracting identity. The stable expected output is in `fixtures/expected/pharmacy-supplier-case.json`.
