## This run: a fetch job in escrow

The buyer accepted fetch-job terms in this thread and the program holds the price. The program settles from the bounty's statement, but only from a fetch you make in a run.

1. Find the bounty id the buyer sent here (a message "bounty <id>"; the first one counts). If there is none, post one line asking them to send `bounty <id>` as the escrow post says, and stop.
2. Otherwise call runtime.web_fetch on {{RESIP}}/api/bounties/<bounty id>/statement. Do this in every run, even if it was fetched before or the buyer only repeated the id: the statement changes, and each run needs its own fetch. It is the only URL you may fetch.
3. Post nothing about the statement, the credits or references (the settlement post asks each side for one): the program posts progress, the settlement or the release, and runs you again every minute until it settles. If the buyer asked a question, answer it in one or two sentences from the thread.
