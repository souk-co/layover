# Release sign-up checks

`release.py` runs `smoke.py` and then invites a unique
`souk-test+release-web-…@soc1024.com` buyer. `smoke.py` itself does not
sign up: it registers a fake guest and exercises marketplace APIs.

`signup-test-mailboxes.json` is explicit deploy configuration, bundled into the
site server. It lists the owned test mailboxes whose normalized identity may
receive repeated invitations. `/api/stats` exposes its distinct count as
`starter_signups.test_mailboxes`, without publishing addresses. An empty list
restores mailbox limits for everyone. Changes require a site deploy.

Only the per-mailbox rolling and durable invitation limits are waived. IP,
global daily, and domain daily caps still apply, and test reservations still
consume daily capacity. Other mailboxes retain all limits, including plus-tag
normalization. Do not add user mailboxes or domains to this list.

This keeps the doorman invitation path covered on every release without
unattended access to emailed login codes. Reusing an authenticated account
would test a different path and require session/code management. This explicit
single-mailbox configuration is the smaller change. Invitations alone do not
sign in or pay starter credit.
