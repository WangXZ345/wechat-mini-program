# Beauty Wholesale Ordering - finesse brief

register: product
one-liner: A WeChat customer pre-order app and a role-aware operations console for beauty wholesale.

## Users & context

Customers browse and place pre-orders on phones. Procurement, finance, customer service, and super administrators use dense operational views repeatedly on mobile or desktop. Interfaces must remain readable in Chinese, fast to scan, and explicit about loading, empty, error, disabled, and permission-denied states.

## Brand personality

soul: restrained warm utility
voice: direct, calm, precise

## Locked dials (project defaults)

SOUL: 3   SPECTACLE: 1   DENSITY: 8

## Visual lock

accent: warm bronze `#B99C74`, with `#A8793A` for active states
theme: light warm-neutral workspace; the web admin may keep its dark sidebar for navigation contrast
type: platform sans-serif in the mini program; Inter with Chinese system fallbacks in the web admin; numeric data uses tabular figures

## Anti-references (must NOT look like)

- Beauty-commerce pink or purple luxury storefront styling.
- Marketing-page composition: oversized hero copy, decorative WebGL, ornamental grain, nested cards, or low-density storytelling.
- A one-note beige interface that removes semantic green, amber, red, and blue status distinctions.
- Visual polish that hides permissions, weakens business-state clarity, or changes an established workflow.

## Notes

- Existing code and `AGENTS.md` business rules override generic finesse substrate rules.
- Keep `letter-spacing: 0`; do not introduce negative tracking as a decorative default.
- UI-only work stays local to the requested surface unless data, permissions, masking, or business state requires a backend change.
- Never expose real inventory, costs, supplier data, internal tags, backend notes, raw identifiers, unmasked customer details, payment proofs, or transaction identifiers to unauthorized roles.
- Preserve order, inventory, payment, refund, shipping, account, address, and permission semantics.
- Prefer compact controls, familiar icons, stable dimensions, explicit states, and measured motion over spectacle.
