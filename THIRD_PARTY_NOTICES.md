# Third-party notices

`borgmcp-server` installs the following production dependency tree from the
public npm registry. Copyright remains with the respective authors. The
license identifiers below are taken from the exact locked package metadata;
refer to each installed package for its complete license text.

| Package | Version | License |
| --- | --- | --- |
| `@noble/hashes` | 1.4.0 | MIT |
| `@peculiar/asn1-cms` | 2.8.0 | MIT |
| `@peculiar/asn1-csr` | 2.8.0 | MIT |
| `@peculiar/asn1-ecc` | 2.8.0 | MIT |
| `@peculiar/asn1-pfx` | 2.8.0 | MIT |
| `@peculiar/asn1-pkcs8` | 2.8.0 | MIT |
| `@peculiar/asn1-pkcs9` | 2.8.0 | MIT |
| `@peculiar/asn1-rsa` | 2.8.0 | MIT |
| `@peculiar/asn1-schema` | 2.8.0 | MIT |
| `@peculiar/asn1-x509` | 2.8.0 | MIT |
| `@peculiar/asn1-x509-attr` | 2.8.0 | MIT |
| `@peculiar/utils` | 2.0.3 | MIT |
| `@peculiar/x509` | 1.14.3 | MIT |
| `asn1js` | 3.0.10 | BSD-3-Clause |
| `borgmcp-shared` | 0.6.1 | Apache-2.0 |
| `bytestreamjs` | 2.0.1 | BSD-3-Clause |
| `pkijs` | 3.4.0 | BSD-3-Clause |
| `pvtsutils` | 1.3.6 | MIT |
| `pvutils` | 1.1.5 | MIT |
| `reflect-metadata` | 0.2.2 | Apache-2.0 |
| `selfsigned` | 5.5.0 | MIT |
| `tslib` | 1.14.1, 2.8.1 | 0BSD |
| `tsyringe` | 4.10.0 | MIT |

The release workflow generates a CycloneDX SBOM from `npm-shrinkwrap.json` for
the exact artifact under review. Development-only packages are recorded in the
source shrinkwrap and generated SBOM but are not installed for package users.
