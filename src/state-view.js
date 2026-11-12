/** Show the author's format without interpreting fields or executing model HTML. */
import { stateText } from "./state-store.js";

export function renderStateView(container, state) {
  const pre = document.createElement("pre");
  pre.className = "stsm-state-text";
  pre.textContent = state.revision ? stateText(state) : "";
  container.replaceChildren(pre);
}
