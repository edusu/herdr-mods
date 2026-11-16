// The tab's right-click menu: the shipped menu's items plus copying the tab's
// terminal addresses, which an agent can pass to `hc read`.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, run, theme, openOverlay, closeOverlay, notify, props } from "herdr";
import { TEXT, Icon } from "./ui.js";

const ROW = 31;
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;

const tabTerminals = (id) =>
  panes()
    .filter((p) => p.tab === id && p.terminal)
    .map((p) => p.terminal);

function tabMenuItems({ id, space }) {
  const terminals = tabTerminals(id);
  return [
    { key: "rename", label: "Rename", icon: "square-pen", command: ["tab.rename", { id }] },
    { key: "new", label: "New tab", icon: "plus", command: ["tab.new", { space }] },
    ...(terminals.length
      ? [{ key: "copy", label: "Copy terminal address", icon: "terminal", hint: terminals.join(", ") }]
      : []),
    { key: "close", label: "Close", icon: "x", command: ["tab.close", { id }] },
  ];
}

export const tabMenuMethods = {
  openTabMenu(tab, space) {
    const target = { id: tab.id, space: space.id };
    openOverlay({
      mod: "better-tabs",
      kind: "popup",
      width: 220,
      // Rows, the separator before Close, and 5px padding on each edge.
      height: tabMenuItems(target).length * ROW + 9 + 10,
      props: { mode: "tab-menu", target, rememberPanels: false },
    });
  },

  chooseTabMenu(item, cx) {
    closeOverlay(props().overlay);
    if (item.command) return run(...item.command);
    cx.write_to_clipboard(item.hint);
    notify({ title: "Copied terminal address", body: item.hint });
  },

  renderTabMenu() {
    const t = theme();
    const items = tabMenuItems(this.config().target ?? {});
    return v_flex()
      .id("tab-menu")
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(TEXT.menu)
      .children(
        items.map((item) =>
          v_flex()
            .when(item.key === "close", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`tab-menu-${item.key}`)
                .h(ROW)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .text_color(t.foreground)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.chooseTabMenu(item, cx))
                .child(Icon(chrome(item.icon)).text_color(t.muted))
                .child(div().flex_1().min_w(0).truncate().child(item.label))
                .when(Boolean(item.hint), (el) =>
                  el.child(div().text_size(11).text_color(t.dim).truncate().child(item.hint)),
                ),
            ),
        ),
      );
  },
};
