# Starter signup abuse limits

The doorman groups addresses by trimmed, NFC-normalized lowercase email, removes the local part's +tag, and removes dots for gmail.com and googlemail.com. Both Google domains share gmail.com as their abuse identity and domain bucket. The address supplied by the user still goes to souk_invite for mail delivery.

A mailbox can be invited once per role. Durable hashed mailbox/domain reservations are serialized and written before inviting. Failed or uncertain upstream calls consume the reservation: the upstream may already have admitted the buyer. An operator must reconcile a definitively failed invitation before removing its reservation. Existing invitations before this change have no web reservation history; accounts separately normalizes historical starter ledger rows.

`STARTERS_PER_DAY` defaults to 200 and `STARTERS_PER_DOMAIN_PER_DAY` to 20; non-negative integer values, including zero to stop new starter-eligible invitations, are accepted. Only buyer invitations consume daily caps. UTC midnight resets capacity, while mailbox duplicate protection remains permanent. `/api/stats` includes `starter_signups` with `global`, `per_domain`, `used_today`, and `day`; no mailbox or domain list is published. The existing per-IP/hour and normalized-email/day request limits still apply. State requires the existing persistent data directory and single-writer service model.

To set caps via deploy.py, supply both desired cap environment variables and the doorman credential: the webhost manifest env replaces the stored env. No deployment is part of this change.

## Amin follow-up

The amin currently pays souk credit on Joined. Deferring it is not a small isolated move: accepted fetch/lease quotes immediately call credits.hold, so payment must complete before the hold, with a durable per-person once-only marker across threads and explicit failed/unknown outcome handling. The escrow and couch acceptance paths also differ. This change leaves that policy untouched; moving it safely needs dedicated lifecycle tests. Web invitation limits constrain new buyer admissions; direct invitations by other souk members remain outside the web gate.
