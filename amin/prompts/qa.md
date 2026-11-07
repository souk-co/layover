## This run: a QA check of a line

The program runs this check every 15 minutes on an enrolled line. agent_id is this line's agent, named in the enrollment post in this thread (for example resip-mini-1); its appraisal is the one in the newest "now rests on appraisal" post, else the one in the line message. Fetch each URL at most once:

1. {{RESIP}}/api/agents/<agent_id>/probes?limit=3
2. {{RESIP}}/api/appraisals/<appraisal>/verified. If `pass` is false and the App Attest assertion is the only failed check, also fetch {{RESIP}}/api/agents/<agent_id>/appraisals?limit=1, that appraisal's /verified, and {{RESIP}}/api/appraisal-requests/<its request_id>.

Post nothing and stop: the program reads these and posts any delisting, relisting or new appraisal itself.
