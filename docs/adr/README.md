# Architecture decision records

Decisions that are hard to reverse, surprising without context, and the result of a real trade-off. Read the ones touching your area before proposing a change to it; if you want to reverse one, say so explicitly and why.

## Format

One file per decision, numbered in sequence: `0001-slug.md`, `0002-slug.md`. Take the next free number.

```md
# Short title of the decision

1-3 sentences: the context, what was decided, and why. Name the rejected alternative when a reader would otherwise suggest it again.
```

A single paragraph is enough. Add a `Status` line (`accepted`, `superseded by ADR-NNNN`) or a short Consequences section only when it adds something.

Domain terms follow [GLOSSARY.md](../../GLOSSARY.md). Scope and history: [PRD #1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1).

## Records

- [0001](0001-layout-from-topology.md): the layout comes from the panel's topology, never from per-model code
- [0002](0002-analog-axes-as-transfer-variables.md): analog axes are input transfer variables, not layout controls
- [0003](0003-four-way-button-is-one-key.md): a four-way button is one key
- [0004](0004-panel-settings-opt-in.md): panel settings are opt-in
- [0005](0005-layout-settings-on-the-connection.md): layout-affecting settings are connection settings
