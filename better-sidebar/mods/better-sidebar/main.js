// Better Sidebar: spaces, agents, both in one block (lists), a footer and a right
// panel toggle. A layout puts one copy per block, and `view` in its props picks which part.
import { View } from "gpui-kit";
import { props } from "herdr";
import { loadSettings } from "./settings.js";
import { setScale } from "./views/ui.js";
import { Spaces } from "./views/spaces.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { Agents } from "./views/agents.js";
import { Lists } from "./views/lists.js";
import { Footer } from "./views/footer.js";
import { PanelToggle } from "./views/panel-toggle.js";

const PARTS = { lists: Lists, agents: Agents, footer: Footer, "panel-toggle": PanelToggle };

export default class BetterSidebar extends View {
  init(given, cx) {
    const Part = PARTS[props()?.view] ?? Spaces;
    this.part = new Part();
    this.part.init(given, cx);
    // Every part, not just Spaces, which reads the rest of the settings.
    cx.spawn(async (cx) => {
      setScale((await loadSettings("better-sidebar", DEFAULT_SETTINGS)).settings);
      cx.notify();
    });
  }

  render(cx) {
    return this.part.render(cx);
  }
}
