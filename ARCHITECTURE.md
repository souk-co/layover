# Layover architecture

Layover is Airbnb for your agents: buyers rent spare capacity on a host's Mac as an attested shell, a page-fetch job, or a timed connection lease. The current deployment uses Base Sepolia test credit. Contracts are not externally audited. See [README.md](README.md) for the entry point and [HOSTING.md](HOSTING.md) for host setup.

## Parties

- **Buyer:** an agent acting for its principal, choosing terms, verifying the guest and authorizing payment.
- **Host:** a Mac operator offering compute or connectivity under house rules; receives payment for signed usage.
- **Amin:** the matching and negotiation agent. It enrolls offers, quotes terms and follows settlement; it holds no money.
- **Broker:** tracks fleet ownership and available couch slots, admits stays, routes connections and accounts for guest-signed seconds.
- **Site:** signup, listings, appraisal requests, connection jobs, leases and statements. It verifies guest evidence and serves the buyer kit.
- **Account service:** optional per-email wallets, starter credit and gas-paid relaying of buyer authorizations. Buyers with their own wallets can call contracts directly.
- **Chain reads:** the chain-read service supplies Helios-verified, block-pinned contract state for build approval, enrollment, ownership and escrow checks. Consumers must check freshness and the expected chain and contracts.

## Three deals

### Couch stay

The buyer asks the amin for a shell and accepts a card. The couch kit asks the broker for a slot, verifies the runner enrollment, approved build, guest manifest and ownership, then connects to the guest. The buyer uses shell and file tools in the guest workspace. Closing the stay seals its record; the broker accounts for signed active guest seconds against its wallet and escrow path. The buyer reports the settlement record to the amin.

### Fetch job

The buyer names domains, page count and a price limit; the amin matches a line and posts terms. After accepting and verifying the guest, the buyer submits URLs as a bounty. The line guest accepts or declines and signs results containing status, size and content hashes. The site exposes a statement; the amin follows settlement for successful pages, returning the unused hold. This interface returns evidence of fetching, rather than page bodies. Legacy flows use site/souk test balances; they should not be confused with token escrow payments.

### Lease

The buyer negotiates domains, duration and shared or exclusive use. For the token-backed path, the account service deposits LAYC and relays signed acceptance into GuestEscrow. It checks guest identity, ownership and fresh escrow state before constructing a sealed lease admission. The guest enforces the agreed domains and policy. A local buyer proxy carries requests through the guest's connection. The guest signs cumulative byte claims; GuestEscrow pays the host within the authorized cap, and closing/releasing terms frees the unused exposure for withdrawal. Legacy test-balance leases also exist.

## Published contract configuration

These Base Sepolia (chain ID 84532) addresses are recorded in the exported code; they are configuration, not a claim of a new deployment.

| Contract | Address | Source |
|---|---|---|
| GuestEscrow | `0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA` | [account deployment](accounts/deploy.py) |
| LayoverCredit (LAYC) | `0x9e851Bf5E3b613aaA09853A07D1132F49c90b515` | [account deployment](accounts/deploy.py) |
| AppleAttestRegistryV1, GuestEscrow verifier | `0xA609124be069225ee2af58741bc109F4bffAB6C3` | [account documentation](accounts/README.md) |
| AppleAttestRegistryV1, key directory | `0x04f57D219B1CEaE7f000C2a3360Ce49CffF3162e` | [host enrollment](host/join.sh) |
| CDRegistry | `0x14b569c5D81d42621c5C0d4d62185239C86D8d20` | [host enrollment](host/join.sh) |
| Canary | `0x95afFDb230772F350dF71d1DF5597FCC69a690D3` | [couch policy](couch/dsmack/sandbox-policy.json) |
| UsageEscrow, couch policy | `0x835A61a88Cc8D750b5a971219aa8f9813B2067e6` | [couch registration](couch/dsmack/repin.sh) |
| UsageEscrow, host setup default | `0x8FF468c8E447f6cF70f05bEa1cEc1693eC0455cE` | [host enrollment](host/join.sh) |

The host setup and couch policy name different UsageEscrow deployments. Ownership signatures and admission must use the deployment selected by their flow. The key directory and GuestEscrow verifier are also distinct: enrollment in one does not enroll a key in the other.

## Trust boundaries

**On the Mac: App Attest.** The signed runner uses a Secure Enclave App Attest key. Registry enrollment ties the key to an Apple-rooted attestation and an approved CDRegistry build. Runner assertions bind the guest's measured image/manifest and keys; buyers check this evidence before sending work. Guest signatures bind results and usage to that identity. Host availability, ISP terms and owner-reported connection properties remain separate from attestation. App Attest is a runner trust boundary, not an Intel TDX quote for the Mac guest.

**On the pod: Intel TDX.** Pod services run under the attested webhost/TEE boundary. The account service has its own container and volume and derives wallet, relayer, session and admission keys inside the TEE. Container isolation and measured deployment constrain access, but the deployment authority can replace project code and derive the same project-bound keys. Attestation makes that replacement observable; it does not remove this authority's trust. The site, broker, account service and chain-read service remain separate roles even when hosted on the same pod.

**Payment and privacy.** Matching does not authorize spending: buyer signatures, escrow state and verified guest claims do. Neither the amin's prose nor a listing substitutes for these checks. Public listings and appraisals describe coarse connection properties without publishing a host's network address. The optional account service adds custody and email authentication trust; a self-managed wallet avoids that custody boundary.
