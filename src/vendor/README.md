# Vendored calculation modules

These files are verbatim copies of the pure calculation modules from the
source systems, so NOIRXU AI reports the same numbers the original sites show.
Do not edit them here; re-copy from the pinned commit instead.

| File | Source | Commit |
|---|---|---|
| `ledger/ledger-engine.mjs` | `GODXU87/noirxu-ledger` `app/lib/ledger-engine.mjs` | `aa906bb` |
| `ledger/asset-model.mjs` | `GODXU87/noirxu-ledger` `app/lib/asset-model.mjs` | `aa906bb` |
| `ledger/net-worth-model.mjs` | `GODXU87/noirxu-ledger` `app/lib/net-worth-model.mjs` | `aa906bb` |
| `journal/financial-math.mjs` | `GODXU87/noirxu-trading-journal` `app/lib/financial-math.js` | `804ac82` |
| `journal/trading-engine.mjs` | `GODXU87/noirxu-trading-journal` `app/lib/trading-engine.js` | `804ac82` |
| `journal/analytics-engine.mjs` | `GODXU87/noirxu-trading-journal` `app/lib/analytics-engine.js` | `804ac82` |

The only change is the file extension (`.js` → `.mjs`) and the matching import
path, so Node treats them as ES modules.
