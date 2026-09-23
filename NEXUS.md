# Nexus project memory

Read `HANDOVER.md` for operational details. Do not store API tokens, SSH private
keys, or their encoded contents in this repository or in chat summaries.

## Kaggle compute (verified 2026-09-23)

- The live VPS has independent Kaggle A/B/C notebook slots on reverse-tunnel
  ports 20140/20141/20142. The watchdog and per-slot credentials are under
  `/root/.kaggle-accounts`; Nexus maps these ports in
  `server/lib/computeManager.js`.
- Kaggle A was moved to account `olasales1` on 2026-09-23. Its staged private
  notebook is `olasales1/notebook5db41fbc2c` and its private tunnel-key input
  dataset is `olasales1/nexus-tunnel-key`. B and C were not changed.
- A's first run validated two T4 GPUs, internet and the restricted tunnel key.
  Through VPS port 20140, `/health` returned OK, `/props` reported context
  131072 and vision enabled, and `/completion` generated `READY`. Nexus's saved
  mode was `kaggle` with active slot `a`. This was a model-endpoint check, not
  a separately verified authenticated Nexus chat turn.
- A token by itself does not make the model available. Check the notebook run,
  the port-20140 `/props` response, and Nexus's selected mode before claiming
  connection. The watchdog may need about 30-45 minutes for a cold build.

## Agent reliability (2026-09-23)

- Agent state saves the current task, last observed tool result and evidence ID
  after every action. On resume, inspect exact output before repeating work.
- The client pins a small index of relevant old tool evidence to the latest
  request. Historical results still require checking against current files.
- Multi-part work uses `set_acceptance_criteria`; each criterion needs its own
  current `verify_work` proof. Two failed verification attempts pause edits
  until a fresh diagnosis. A turn has a 15-minute cap and 2-minute reserve.
- Reply timing shows measured generation speed and wall time; it is diagnostic,
  not a promise of task completion. A truncated response or intermediate
  success is not evidence the whole project passed.
