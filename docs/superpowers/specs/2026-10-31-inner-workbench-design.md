# Editorial inner workbench

Intent: replace stacked boxes on tasks/Today/results/memory with a calm reading and action hierarchy, retaining the dark NOIRXU brand. Parent approved this direction after live user feedback that controls and inner pages still look boxed.

Approaches: (1) editorial rows and section rhythm, recommended and approved; (2) a single board with nested cards, rejected because it retains card density. This is not a radius-only restyle.

Design: large page title and restrained lead; borderless major sections separated by whitespace/rules; Today underlined state filters with counts and source labels, readable next steps and a clear text action; acceptance evidence as a three-stage rail rather than three cards; task results as an inset evidence rail with unboxed source links; memory category rows and quiet inline controls. Inputs retain real boundaries, primary actions retain accent fill, focus is visible and targets at least 44px. Mobile typography scales without clipped headings or long URLs. State messages remain honest; loading has accessible status and actual busy labels.

Scope: presentation in FunctionPages, Acceptance, LongTermMemory, and scoped CSS. No API, auth, scheduler, native approval, stored data or provider changes; preserve unknown/manual/unverified language and original actions. No fonts or dependency downloads. Actual-component synthetic QA only; no production root/catchup, real records or outgoing calls. Preview requires coordinated slot. Design reviewed with parent; no publication until candidate handoff.
