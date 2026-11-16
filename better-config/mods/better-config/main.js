// Better Config: every installed mod's settings in one dialog, drawn like
// Herdr's own Settings. Values stay in each mod's mod.json `settings` block,
// where the mod (and any helper beside it) already reads them, and Herdr
// reloads a mod when that file is saved. A copy of what the person changed is
// kept in ~/.config/herdr-mods/better-config/, outside every mod, so values an
// update wiped can be put back.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, Select, Popup, Checkbox } from "gpui-base";
import { appHome, home, exec, readTextFile, writeTextFile, theme, props, closeOverlay, run } from "herdr";
import {
  fieldsOf,
  getPath,
  problemWith,
  parseInput,
  showValue,
  isChanged,
  changedValues,
  lostValues,
  editManifest,
  editSettingsFile,
  equal,
  stepValue,
  APP_SCHEMA,
  validProfileName,
  withValue,
  profileEntries,
  profileDiff,
} from "./model.js";

const I = (name) => `mods/better-config/icons/${name}.svg`;
const POLL_MS = 3000;
// Herdr's own settings.json shows as one more page, under a name no mod folder can have.
const APP = "@herdr";
const PROFILE = "profile:";

export default class BetterConfig extends View {
  init(_props, cx) {
    this.mods = [];
    this.loaded = false;
    this.section = null;
    this.inputs = {}; // "mod:key" → { state, focused }
    this.unticked = new Set();
    this.notes = {}; // "mod:key" → why the typed value wasn't saved
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.menuFocus = cx.focus_handle();
    this.triggerFocus = cx.focus_handle();
    this.openMenu = null; // the dropdown that's open
    this.menuIndex = 0;
    this.profiles = []; // { name, path, raw, profile }
    this.confirmDelete = null;
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
    // Picks up edits made by hand, or by an update, while the dialog is open.
    cx.timer.every(POLL_MS, (cx) =>
      cx.spawn(async (cx) => {
        if (await this.load()) cx.notify();
      }),
    );
  }

  keptFolder() {
    return `${home()}/.config/herdr-mods/better-config`;
  }

  // Every installed mod with settings: described by its mod.schema.json, or set in its mod.json. Returns whether anything changed.
  async load() {
    const listing = await exec("/bin/sh", ["-c", 'cd "$1" && ls -d */ 2>/dev/null', "sh", `${appHome()}/mods`]);
    const names = listing.stdout.split("\n").map((n) => n.replace(/\/$/, "")).filter(Boolean);
    const mods = [await this.loadApp()];
    for (const name of names) {
      const path = `${appHome()}/mods/${name}/mod.json`;
      const raw = await readTextFile(path);
      if (raw === null) continue;
      let manifest = null;
      let error = null;
      try {
        manifest = JSON.parse(raw);
      } catch (e) {
        error = `mod.json isn't valid JSON, so nothing here can be changed until it's fixed: ${e.message}`;
      }
      let schema = null;
      try {
        schema = JSON.parse((await readTextFile(`${appHome()}/mods/${name}/mod.schema.json`)) ?? "null");
      } catch {}
      const fields = fieldsOf(schema, manifest?.settings);
      if (manifest && !fields.length) continue;
      if (!manifest && !schema?.properties?.settings && !/"settings"/.test(raw)) continue;
      const keptPath = `${this.keptFolder()}/${name}.json`;
      const keptRaw = await readTextFile(keptPath);
      let kept = null;
      try {
        kept = keptRaw ? JSON.parse(keptRaw) : null;
      } catch {}
      const mod = { name, path, raw, manifest, schema, fields, error, keptPath, keptRaw, kept, lost: {} };
      if (manifest) {
        mod.lost = lostValues(kept, fields, manifest);
        // Nothing lost: the copy follows the file, including edits made by hand.
        if (!Object.keys(mod.lost).length) await this.keep(mod);
      }
      mods.push(mod);
    }
    mods.sort((a, b) => (a.app ? -1 : b.app ? 1 : this.titleOf(a).localeCompare(this.titleOf(b))));
    const profiles = await this.loadProfiles();
    const state = (ms, ps) => JSON.stringify([ms.map((m) => [m.name, m.raw, m.keptRaw]), ps.map((p) => [p.name, p.raw])]);
    const before = state(this.mods, this.profiles);
    this.mods = mods;
    this.profiles = profiles;
    this.loaded = true;
    const known = mods.some((m) => m.name === this.section) || profiles.some((p) => PROFILE + p.name === this.section);
    if (!known) this.section = mods[0]?.name ?? null;
    this.makeInputs();
    return before !== state(mods, profiles);
  }

  // settings.json as a page like a mod's, described by Better Config's own schema.
  async loadApp() {
    const path = `${appHome()}/settings.json`;
    const raw = await readTextFile(path);
    let settings = {};
    let error = null;
    try {
      settings = JSON.parse(raw ?? "{}");
    } catch (e) {
      error = `settings.json isn't valid JSON, so nothing here can be changed until it's fixed: ${e.message}`;
    }
    const manifest = error ? null : { title: "Herdr", settings };
    return { name: APP, app: true, path, raw, manifest, schema: APP_SCHEMA, fields: fieldsOf(APP_SCHEMA, settings), error, lost: {} };
  }

  profilesFolder() {
    return `${this.keptFolder()}/profiles`;
  }

  async loadProfiles() {
    const listing = await exec("/bin/sh", ["-c", 'cd "$1" 2>/dev/null && ls -1 -- *.json 2>/dev/null', "sh", this.profilesFolder()]);
    const profiles = [];
    for (const file of listing.stdout.split("\n").filter(Boolean)) {
      const name = file.replace(/\.json$/, "");
      if (!validProfileName(name)) continue;
      const path = `${this.profilesFolder()}/${file}`;
      const raw = await readTextFile(path);
      let profile = { values: {} };
      try {
        profile = JSON.parse(raw ?? "{}");
      } catch {}
      profiles.push({ name, path, raw, profile });
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  // A setting's value as it stands, its default included; undefined when the mod isn't installed.
  valueNow(modName, key) {
    const mod = this.mods.find((m) => m.name === modName);
    if (!mod?.manifest) return undefined;
    return getPath(mod.manifest.settings, key) ?? mod.fields.find((f) => f.key === key)?.default;
  }

  installed(modName) {
    return this.mods.some((m) => m.name === modName && m.manifest);
  }

  // What applying would still change, among installed mods. Empty: the profile is in place.
  pending(entry) {
    return profileDiff(entry.profile, (m, k) => this.valueNow(m, k)).filter(([m]) => this.installed(m));
  }

  // Writes a profile only if nobody changed it meanwhile; a new one only if the name is free.
  saveProfile(entry, profile, cx) {
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", this.profilesFolder()]);
        await writeTextFile(entry.path, `${JSON.stringify(profile, null, 2)}\n`, entry.raw);
        delete this.notes[`${PROFILE}${entry.name}`];
      } catch (e) {
        this.notes[`${PROFILE}${entry.name}`] = `Couldn't save the profile: ${e?.message ?? e}`;
      }
      await this.load();
      cx.notify();
    });
  }

  newProfile(cx) {
    let n = this.profiles.length + 1;
    while (this.profiles.some((p) => p.name === `Profile ${n}`)) n++;
    const name = `Profile ${n}`;
    this.section = PROFILE + name;
    this.saveProfile({ name, path: `${this.profilesFolder()}/${name}.json`, raw: null }, { values: {} }, cx);
  }

  renameProfile(entry, name, cx) {
    const id = `${PROFILE}${entry.name}`;
    if (name === entry.name) return;
    if (!validProfileName(name)) this.notes[id] = "A name can't be empty, start with a dot or have a slash.";
    else if (this.profiles.some((p) => p.name === name)) this.notes[id] = `There's already a profile called ${name}.`;
    else {
      delete this.notes[id];
      cx.spawn(async (cx) => {
        await exec("mv", ["-n", entry.path, `${this.profilesFolder()}/${name}.json`]);
        this.section = PROFILE + name;
        await this.load();
        cx.notify();
      });
    }
    cx.notify();
  }

  deleteProfile(entry, cx) {
    cx.spawn(async (cx) => {
      await exec("rm", ["-f", "--", entry.path]);
      this.confirmDelete = null;
      this.section = this.mods[0]?.name ?? null;
      await this.load();
      cx.notify();
    });
  }

  // Sets the profile's values, one write per mod; settings it doesn't hold stay as they are.
  applyProfile(entry, cx) {
    const byMod = {};
    for (const [mod, key, value] of this.pending(entry)) (byMod[mod] ??= []).push([key, value]);
    for (const [mod, edits] of Object.entries(byMod)) this.change(mod, edits, cx);
  }

  // A setting's profile chip: off adds the current value, a stale one takes the current value,
  // a matching one leaves the profile.
  toggleInProfile(entry, mod, field, cx) {
    const now = this.valueNow(mod.name, field.key);
    const held = entry.profile?.values?.[mod.name]?.[field.key];
    const inside = held !== undefined;
    const next = inside && equal(held, now) ? undefined : now;
    if (next === undefined && !inside) return;
    this.saveProfile(entry, withValue(entry.profile, mod.name, field.key, next), cx);
  }

  titleOf(mod) {
    return mod.manifest?.title ?? mod.name;
  }

  // Writes the copy of this mod's changed values, when it differs.
  async keep(mod) {
    const next = { version: mod.manifest.version ?? null, values: changedValues(mod.fields, mod.manifest.settings) };
    if (mod.kept && equal(mod.kept, next)) return;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    try {
      if (mod.keptRaw === null) await exec("mkdir", ["-p", this.keptFolder()]);
      await writeTextFile(mod.keptPath, text, mod.keptRaw);
      mod.kept = next;
      mod.keptRaw = text;
    } catch {}
  }

  // Changes one setting in a mod's mod.json, the way Herdr's Settings changes its own file:
  // only if nobody changed it meanwhile, else read again and redo.
  change(name, edits, cx) {
    cx.spawn(async (cx) => {
      let failed = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const mod = this.mods.find((m) => m.name === name);
        if (!mod || mod.error) break;
        try {
          let text = mod.raw;
          for (const [key, value] of edits) {
            const field = mod.fields.find((f) => f.key === key) ?? { key };
            text = mod.app ? editSettingsFile(text, field, value) : editManifest(text, field, value);
          }
          await writeTextFile(mod.path, text, mod.raw);
          mod.raw = text;
          mod.manifest = mod.app ? { ...mod.manifest, settings: JSON.parse(text) } : JSON.parse(text);
          mod.fields = fieldsOf(mod.schema, mod.manifest.settings);
          // The copy follows at once, so a reset never reads as a loss.
          if (!mod.app) await this.keep(mod);
          failed = null;
          break;
        } catch (e) {
          failed = e?.message ?? String(e);
          await this.load();
        }
      }
      if (failed) this.notes[`${name}:*`] = `Couldn't save: ${failed}`;
      else delete this.notes[`${name}:*`];
      await this.load();
      cx.notify();
    });
  }

  // Back to what the mod ships with: its described default, or nothing.
  reset(mod, field, cx) {
    delete this.notes[`${mod.name}:${field.key}`];
    this.change(mod.name, [[field.key, field.default]], cx);
  }

  // Puts back the lost values still ticked; the rest stay as they are now, and the copy
  // forgets them once the write updates it.
  restore(mod, cx) {
    const picked = Object.entries(mod.lost).filter(([key]) => !this.unticked.has(`${mod.name}:${key}`));
    for (const key of Object.keys(mod.lost)) this.unticked.delete(`${mod.name}:${key}`);
    if (picked.length) this.change(mod.name, picked, cx);
    else this.forget(mod, cx);
  }

  // The values aren't wanted back: the copy starts again from the file.
  forget(mod, cx) {
    cx.spawn(async (cx) => {
      mod.kept = null;
      mod.lost = {};
      await this.keep(mod);
      await this.load();
      cx.notify();
    });
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Pieces, as Herdr's Settings draws them -------------------------------

  heading(t, text) {
    return div().pt(18).pb(2).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .flex_none()
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  toggle(t, id, on, onClick) {
    return div()
      .id(id)
      .w(36)
      .h(20)
      .rounded(10)
      .p(2)
      .cursor_pointer()
      .bg(on ? t.accent : t.hover)
      .flex()
      .when(on, (el) => el.justify_end())
      .on_click((_e, cx) => onClick(cx))
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  segments(t, id, choices, now, onPick) {
    return h_flex()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        Object.entries(choices).map(([value, label]) =>
          div()
            .id(`${id}-${value}`)
            .px(12)
            .py(4)
            .rounded(6)
            .text_size(13)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => onPick(value, cx))
            .child(label),
        ),
      );
  }

  // A dropdown for a choice with too many options for buttons. Arrows, Enter and Esc work in it.
  dropdown(t, id, label, choices, now, onPick) {
    const entries = Object.entries(choices);
    const open = this.openMenu === id;
    const setOpen = (value, cx) => {
      this.openMenu = value ? id : null;
      this.menuIndex = Math.max(0, entries.findIndex(([v]) => v === now));
      // Opened by a click, the keyboard would stay on the trigger.
      if (value) this.menuFocus.focus();
      else this.handle.focus();
      cx.notify();
    };
    const pick = (value, cx) => {
      setOpen(false, cx);
      if (value !== now) onPick(value, cx);
    };
    const trigger = h_flex()
      .id(`${id}-trigger`)
      .h(28)
      .min_w(140)
      .px(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .text_size(13)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => setOpen(!open, cx))
      .child(div().flex_1().truncate().child(choices[now] ?? String(now ?? "")))
      .child(svg(I("chevron-down")).size(12).text_color(t.dim));
    const menu = v_flex()
      .id(`${id}-menu`)
      .w(200)
      .max_h(300)
      .p(5)
      .gap(1)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .track_focus(this.menuFocus)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") setOpen(false, cx);
        else if (k === "up" || k === "down") {
          this.menuIndex = (this.menuIndex + (k === "down" ? 1 : entries.length - 1)) % entries.length;
          cx.notify();
        } else if (k === "enter" || k === "space") pick(entries[this.menuIndex][0], cx);
        else return;
        cx.stop_propagation();
      })
      .children(
        entries.map(([value, label], i) =>
          h_flex()
            .id(`${id}-option-${value}`)
            .h(30)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .text_size(13)
            .text_color(t.foreground)
            .cursor_pointer()
            .role("list_box_option")
            .aria_selected(value === now)
            .when(i === this.menuIndex, (el) => el.aria_active_descendant().bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => pick(value, cx))
            .child(div().flex_1().truncate().child(label))
            .when(value === now, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))),
        ),
      );
    // Base owns the open state and moving the keyboard onto the list; the list moves its highlight.
    return Select.new(id)
      .accessibility_label(label)
      .open(open)
      .when(open, (el) => el.track_focus(this.triggerFocus))
      .content_focus_handle(this.menuFocus)
      .on_open_change((value, cx) => setOpen(value, cx))
      .child(Popup.new(`${id}-popup`, trigger).anchor("top_right").when(open, (el) => el.content(menu)));
  }

  // − value +
  stepper(t, id, value, step, onStep) {
    const b = (k, label, by) =>
      div()
        .id(`${id}-${k}`)
        .w(28)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(15)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => onStep(by, cx))
        .child(label);
    return h_flex()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .overflow_hidden()
      .child(b("minus", "−", -step))
      .child(div().min_w(54).px(6).text_size(13).text_color(t.foreground).flex().justify_center().child(String(value)))
      .child(b("plus", "+", step));
  }

  // Text boxes for the settings typed in. Herdr allows making them only outside render,
  // so they're made here, after each load.
  makeInputs() {
    for (const entry of this.profiles) this.makeNameInput(entry);
    for (const mod of this.mods) {
      if (!mod.manifest) continue;
      for (const field of mod.fields)
        if (this.usesBox(field, getPath(mod.manifest.settings, field.key))) this.makeInput(mod.name, field);
    }
  }

  usesBox(field, value) {
    const shown = value === undefined ? field.default : value;
    if (field.type === "boolean") return false;
    if (field.type === "choice" && field.choices) return false;
    return !(field.type === "number" && typeof shown === "number");
  }

  makeInput(name, field) {
    const id = `${name}:${field.key}`;
    if (this.inputs[id]) return;
    const value = getPath(this.mods.find((m) => m.name === name)?.manifest?.settings, field.key);
    const state = InputState.new({ placeholder: field.default === undefined ? "" : showValue(field.default) });
    state.set_value(showValue(value));
    const box = (this.inputs[id] = { state, focused: false, shown: showValue(value) });
    // Saves on Enter or when the box loses focus.
    const commit = (cx) => {
      const now = this.mods.find((m) => m.name === name);
      const f = now?.manifest && now.fields.find((x) => x.key === field.key);
      if (!f) return;
      const typed = state.value();
      if (typed === showValue(getPath(now.manifest.settings, f.key))) return;
      const parsed = parseInput(f, typed);
      if (parsed.error) this.notes[id] = parsed.error;
      else {
        delete this.notes[id];
        this.change(name, [[f.key, parsed.value]], cx);
      }
      cx.notify();
    };
    state.on("focus", (_e, cx) => {
      box.focused = true;
      cx.notify();
    });
    state.on("blur", (_e, cx) => {
      box.focused = false;
      commit(cx);
    });
    state.on("submit", (_e, cx) => commit(cx));
  }

  makeNameInput(entry) {
    const id = `${PROFILE}${entry.name}`;
    if (this.inputs[id]) return;
    const state = InputState.new({ placeholder: "Profile name" });
    state.set_value(entry.name);
    const box = (this.inputs[id] = { state, focused: false, shown: entry.name });
    const commit = (cx) => {
      const now = this.profiles.find((p) => p.name === entry.name);
      if (now) this.renameProfile(now, state.value().trim(), cx);
    };
    state.on("focus", (_e, cx) => {
      box.focused = true;
      cx.notify();
    });
    state.on("blur", (_e, cx) => {
      box.focused = false;
      commit(cx);
    });
    state.on("submit", (_e, cx) => commit(cx));
  }

  // One chip per profile under a setting: filled when the profile holds it, dotted when what it holds isn't the value now.
  profileChips(t, mod, field) {
    if (!this.profiles.length || !mod.manifest) return null;
    const now = this.valueNow(mod.name, field.key);
    return h_flex()
      .gap(4)
      .pt(2)
      .flex_wrap()
      .children(
        this.profiles.map((entry) => {
          const held = entry.profile?.values?.[mod.name]?.[field.key];
          const inside = held !== undefined;
          const stale = inside && !equal(held, now);
          const tip = !inside
            ? `Add this value to ${entry.name}`
            : stale
              ? `${entry.name} holds ${showValue(held) || "empty"}: click to take the value now`
              : `Remove from ${entry.name}`;
          return h_flex()
            .id(`bc-chip-${entry.name}-${mod.name}-${field.key}`)
            .gap(4)
            .items_center()
            .px(6)
            .py(1)
            .rounded(5)
            .border_1()
            .text_size(11)
            .cursor_pointer()
            .border_color(inside ? t.accent : t.border)
            .bg(inside && !stale ? t.accent : "#00000000")
            .text_color(inside && !stale ? t.accent_foreground : inside ? t.accent : t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(tip)
            .on_click((_e, cx) => this.toggleInProfile(entry, mod, field, cx))
            .when(stale, (el) => el.child(div().w(5).h(5).rounded(3).bg(t.accent)))
            .child(entry.name);
        }),
      );
  }

  // A profile: its name, Apply, and each value it holds beside the value now.
  profilePage(t, entry) {
    const pending = this.pending(entry);
    const entries = profileEntries(entry.profile);
    const id = `${PROFILE}${entry.name}`;
    const box = this.inputs[id];
    if (box && !box.focused && box.shown !== entry.name) {
      box.state.set_value(entry.name);
      box.shown = entry.name;
    }
    const shown = (mod, key, value) => {
      const field = mod?.fields.find((f) => f.key === key);
      return value === undefined || showValue(value) === "" ? "empty" : (field?.choices?.[value] ?? showValue(value));
    };
    const deleting = this.confirmDelete === entry.name;
    const byMod = [];
    for (const [modName, key, value] of entries) {
      let group = byMod.find((g) => g.modName === modName);
      if (!group) byMod.push((group = { modName, items: [] }));
      group.items.push([key, value]);
    }
    return v_flex()
      .child(
        h_flex()
          .h(30)
          .gap(10)
          .items_center()
          .child(
            div()
              .w(240)
              .h(28)
              .px(8)
              .flex()
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(this.notes[id] ? t.ansi1 : box?.focused ? t.accent : t.border)
              .bg(t.background)
              .text_size(15)
              .child(box ? Input.new(box.state).h(26).w_full().text_color(t.foreground) : entry.name),
          )
          .child(div().flex_1())
          .child(
            pending.length
              ? this.button(t, `bc-apply-${entry.name}`, `Apply ${pending.length}`, (cx) => this.applyProfile(entry, cx))
              : div().text_size(12.5).text_color(t.dim).child(entries.length ? "In place" : ""),
          )
          .child(
            this.button(t, `bc-delete-${entry.name}`, deleting ? "Delete for good" : "Delete", (cx) => {
              if (deleting) this.deleteProfile(entry, cx);
              else {
                this.confirmDelete = entry.name;
                cx.notify();
              }
            }),
          ),
      )
      .child(
        div()
          .pt(4)
          .text_size(12.5)
          .text_color(t.dim)
          .child(
            `Applying sets only the settings below; the rest stay as they are. Add one with the ${entry.name} chip under any setting. Saved to ~/.config/herdr-mods/better-config/profiles/.`,
          ),
      )
      .when(Boolean(this.notes[id]), (el) => el.child(div().pt(10).text_size(13).text_color(t.ansi1).child(this.notes[id])))
      .when(!entries.length, (el) =>
        el.child(div().pt(18).text_size(13).text_color(t.dim).child("No settings yet. Open a mod's page and click this profile's chip under a setting.")),
      )
      .children(
        byMod.map(({ modName, items }) => {
          const mod = this.mods.find((m) => m.name === modName && m.manifest);
          return v_flex()
            .child(this.heading(t, mod ? this.titleOf(mod) : `${modName} (not installed)`))
            .children(
              items.map(([key, value]) => {
                const field = mod?.fields.find((f) => f.key === key);
                const now = this.valueNow(modName, key);
                const differs = mod && !equal(now, value);
                return h_flex()
                  .w_full()
                  .gap(12)
                  .py(9)
                  .items_center()
                  .border_b(1)
                  .border_color(t.border)
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(2)
                      .child(div().text_size(13.5).text_color(t.foreground).child(field?.title ?? key))
                      .child(div().text_size(11.5).text_color(t.dim).font_family("JetBrains Mono").child(key)),
                  )
                  .child(div().text_size(12.5).font_family("JetBrains Mono").text_color(t.foreground).child(shown(mod, key, value)))
                  .when(Boolean(differs), (el) =>
                    el.child(div().text_size(12.5).font_family("JetBrains Mono").text_color(t.dim).child(`now ${shown(mod, key, now)}`)),
                  )
                  .child(
                    div()
                      .id(`bc-drop-${entry.name}-${modName}-${key}`)
                      .px(6)
                      .py(3)
                      .rounded(5)
                      .text_size(12)
                      .text_color(t.dim)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_click((_e, cx) => this.saveProfile(entry, withValue(entry.profile, modName, key, undefined), cx))
                      .child("Remove"),
                  );
              }),
            );
        }),
      );
  }

  textBox(t, mod, field, value) {
    const id = `${mod.name}:${field.key}`;
    const box = this.inputs[id];
    if (!box) return div().text_size(13).text_color(t.dim).child(showValue(value));
    // Follow the file while the person isn't typing in it.
    if (!box.focused && box.shown !== showValue(value)) {
      box.state.set_value(showValue(value));
      box.shown = showValue(value);
      delete this.notes[id];
    }
    return div()
      .w(field.type === "text" || field.type === "list" ? 240 : 120)
      .h(28)
      .px(8)
      .flex()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(this.notes[id] ? t.ansi1 : box.focused ? t.accent : t.border)
      .bg(t.background)
      .text_size(13)
      .child(Input.new(box.state).h(26).w_full().text_color(t.foreground));
  }

  control(t, mod, field, value) {
    const id = `bc-${mod.name}-${field.key}`;
    const set = (v, cx) => this.change(mod.name, [[field.key, v]], cx);
    const shown = value === undefined ? field.default : value;
    if (field.type === "boolean") return this.toggle(t, id, shown === true, (cx) => set(!(shown === true), cx));
    if (field.type === "choice" && field.choices)
      return Object.keys(field.choices).length <= 4
        ? this.segments(t, id, field.choices, shown, (v, cx) => set(v, cx))
        : this.dropdown(t, id, field.title, field.choices, shown, (v, cx) => set(v, cx));
    if (field.type === "number" && typeof shown === "number") {
      return h_flex()
        .gap(6)
        .items_center()
        .child(this.stepper(t, id, shown, field.step, (by, cx) => set(stepValue(field, shown, by), cx)))
        .when(Boolean(field.unit), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(field.unit)));
    }
    return this.textBox(t, mod, field, value);
  }

  // One setting: what it is on the left, the control on the right, any problem under it.
  row(t, mod, field) {
    const value = getPath(mod.manifest.settings, field.key);
    const problem = this.notes[`${mod.name}:${field.key}`] ?? problemWith(field, value);
    const changed = isChanged(field, value);
    const about = field.description;
    return h_flex()
      .w_full()
      .gap(16)
      .py(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(14).text_color(t.foreground).child(field.title))
              .when(changed, (el) => el.child(div().w(6).h(6).rounded(3).bg(t.accent))),
          )
          .when(Boolean(about), (el) =>
            el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about)),
          )
          .child(div().text_size(11.5).text_color(t.dim).font_family("JetBrains Mono").child(field.key))
          .when(Boolean(problem), (el) => el.child(div().text_size(12.5).text_color(t.ansi1).child(problem)))
          .when(this.profiles.length > 0, (el) => el.child(this.profileChips(t, mod, field))),
      )
      .when(changed, (el) =>
        el.child(
          div()
            .id(`bc-reset-${mod.name}-${field.key}`)
            .flex_none()
            .px(6)
            .py(3)
            .rounded(5)
            .text_size(12)
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(`Back to ${showValue(field.default) || "the default"}`)
            .on_click((_e, cx) => this.reset(mod, field, cx))
            .child("Reset"),
        ),
      )
      .child(div().flex_none().child(this.control(t, mod, field, value)));
  }

  // When an update put the shipped values back over the person's own.
  // What an update (or anything else) put back over the person's values: each one, yours then now.
  lostBanner(t, mod) {
    const keys = Object.keys(mod.lost);
    const updated = mod.kept?.version && mod.manifest?.version && mod.kept.version !== mod.manifest.version;
    const ticked = keys.filter((key) => !this.unticked.has(`${mod.name}:${key}`)).length;
    const restoreLabel =
      ticked === keys.length ? "Restore mine" : ticked === 0 ? "Keep the new values" : `Restore ${ticked}, keep ${keys.length - ticked}`;
    const which = keys.length === 1 ? "one of your settings" : `${keys.length} of your settings`;
    const shown = (value, field) =>
      value === undefined || showValue(value) === "" ? "empty" : (field?.choices?.[value] ?? showValue(value));
    return v_flex()
      .mt(14)
      .p(12)
      .gap(10)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(
        div()
          .text_size(13)
          .text_color(t.foreground)
          .child(
            updated
              ? `Updating ${this.titleOf(mod)} from ${mod.kept.version} to ${mod.manifest.version} reset ${which}:`
              : `Something outside Better Config put back ${which}:`,
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .children(
            keys.map((key) => {
              const field = mod.fields.find((f) => f.key === key);
              const now = getPath(mod.manifest?.settings, key) ?? field?.default;
              const id = `${mod.name}:${key}`;
              const on = !this.unticked.has(id);
              return Checkbox.new(`bc-pick-${id}`)
                .checked(on)
                .on_change((checked, cx) => {
                  if (checked) this.unticked.delete(id);
                  else this.unticked.add(id);
                  cx.notify();
                })
                .accessibility_label(`Restore ${field?.title ?? key}`)
                .flex()
                .gap(8)
                .items_center()
                .cursor_pointer()
                .text_size(12.5)
                .child(
                  div()
                    .size(15)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .border_1()
                    .border_color(on ? t.accent : t.border)
                    .bg(on ? t.accent : t.background)
                    .when(on, (el) => el.child(svg(I("check")).size(11).text_color(t.accent_foreground))),
                )
                .child(div().w(150).flex_none().truncate().text_color(t.muted).child(field?.title ?? key))
                .child(div().font_family("JetBrains Mono").text_color(t.foreground).child(shown(mod.lost[key], field)))
                .child(div().text_color(t.dim).child("→"))
                .child(div().font_family("JetBrains Mono").text_color(t.dim).child(`${shown(now, field)}${getPath(mod.manifest?.settings, key) === undefined ? " (default)" : ""}`));
            }),
          ),
      )
      .child(
        h_flex().child(this.button(t, `bc-restore-${mod.name}`, restoreLabel, (cx) => this.restore(mod, cx))),
      );
  }

  page(t, mod) {
    if (!mod)
      return v_flex()
        .gap(6)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child("No mod settings"))
        .child(
          div()
            .text_size(13)
            .text_color(t.dim)
            .child("None of your installed mods has a settings block in its mod.json yet."),
        );
    const fields = mod.manifest ? mod.fields : [];
    const changed = fields.filter((f) => isChanged(f, getPath(mod.manifest.settings, f.key)));
    // Grouped by the first part of the key; one-part keys go first, with no heading.
    const groups = [];
    for (const field of fields) {
      const name = field.key.includes(".") ? field.key.split(".")[0] : "";
      let group = groups.find((g) => g.name === name);
      if (!group) groups.push((group = { name, fields: [] }));
      group.fields.push(field);
    }
    groups.sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : 0));
    const saveNote = this.notes[`${mod.name}:*`];
    return v_flex()
      .child(
        h_flex()
          .h(30)
          .gap(10)
          .items_center()
          .child(div().text_size(18).font_semibold().text_color(t.foreground).child(this.titleOf(mod)))
          .when(Boolean(mod.manifest?.version), (el) =>
            el.child(div().text_size(12.5).text_color(t.dim).child(mod.manifest.version)),
          )
          .child(div().flex_1())
          .when(changed.length > 0, (el) =>
            el.child(
              this.button(t, `bc-reset-all-${mod.name}`, "Reset all", (cx) =>
                this.change(mod.name, changed.map((f) => [f.key, f.default]), cx),
              ),
            ),
          ),
      )
      .child(
        div()
          .pt(4)
          .text_size(12.5)
          .text_color(t.dim)
          .child(
            mod.app
              ? "Saved to settings.json, which Herdr applies at once. Herdr's Settings has the rest."
              : `Saved to mods/${mod.name}/mod.json, which the mod reloads at once.`,
          ),
      )
      .when(Boolean(mod.error), (el) => el.child(div().pt(14).text_size(13).text_color(t.ansi1).child(mod.error)))
      .when(Boolean(saveNote), (el) => el.child(div().pt(14).text_size(13).text_color(t.ansi1).child(saveNote)))
      .when(Object.keys(mod.lost).length > 0, (el) => el.child(this.lostBanner(t, mod)))
      .children(
        groups.map((g) =>
          v_flex()
            .when(Boolean(g.name), (el) => el.child(this.heading(t, g.name.replaceAll("_", " "))))
            .when(!g.name, (el) => el.pt(10))
            .children(g.fields.map((f) => this.row(t, mod, f))),
        ),
      );
  }

  nav(t) {
    return v_flex()
      .flex_none()
      .w(190)
      .h_full()
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Mod settings"))
      .child(
        div()
          .id("bc-nav")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .child(
            v_flex()
              .gap(2)
              .children(
                this.mods.map((mod) => {
                  const on = mod.name === this.section;
                  const attention = mod.error || Object.keys(mod.lost).length > 0;
                  return h_flex()
                    .id(`bc-s-${mod.name}`)
                    .gap(10)
                    .px(10)
                    .py(7)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .bg(on ? t.raised : "#00000000")
                    .hover((s) => s.bg(t.raised))
                    .on_click((_e, cx) => {
                      this.section = mod.name;
                      this.handle.focus();
                      cx.notify();
                    })
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .text_size(13.5)
                        .text_color(on ? t.foreground : t.muted)
                        .child(this.titleOf(mod)),
                    )
                    .when(Boolean(attention), (el) => el.child(div().w(7).h(7).rounded(4).bg(t.ansi1)));
                }),
              )
              .child(div().px(10).pt(16).pb(4).text_size(11.5).font_semibold().text_color(t.dim).child("PROFILES"))
              .children(
                this.profiles.map((entry) => {
                  const on = PROFILE + entry.name === this.section;
                  const inPlace = profileEntries(entry.profile).length > 0 && !this.pending(entry).length;
                  return h_flex()
                    .id(`bc-p-${entry.name}`)
                    .gap(8)
                    .px(10)
                    .py(7)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .bg(on ? t.raised : "#00000000")
                    .hover((s) => s.bg(t.raised))
                    .tooltip(inPlace ? "Every value it holds is in place" : "Click to see and apply it")
                    .on_click((_e, cx) => {
                      this.section = PROFILE + entry.name;
                      this.confirmDelete = null;
                      this.handle.focus();
                      cx.notify();
                    })
                    .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(on ? t.foreground : t.muted).child(entry.name))
                    .when(inPlace, (el) => el.child(svg(I("check")).size(12).text_color(t.accent)));
                }),
              )
              .child(
                div()
                  .id("bc-new-profile")
                  .px(10)
                  .py(7)
                  .rounded(7)
                  .cursor_pointer()
                  .text_size(13)
                  .text_color(t.dim)
                  .hover((s) => s.bg(t.raised).text_color(t.foreground))
                  .on_click((_e, cx) => this.newProfile(cx))
                  .child("+ New profile"),
              ),
          ),
      )
      .child(this.button(t, "bc-herdr", "Herdr settings", () => {
        this.close();
        run("app.settings");
      }));
  }

  render(cx) {
    const t = theme();
    const mod = this.mods.find((m) => m.name === this.section);
    const profile = this.profiles.find((p) => PROFILE + p.name === this.section);
    return h_flex()
      .id("better-config")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .items_start()
      .bg(t.popover)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.close();
      })
      .child(this.nav(t))
      .child(
        div()
          .relative()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            div()
              .id("bc-body")
              .size_full()
              .overflow_y_scroll()
              .child(
                div()
                  .px(28)
                  .py(22)
                  .child(
                    !this.loaded
                      ? div().text_size(13).text_color(t.dim).child("Loading…")
                      : profile
                        ? this.profilePage(t, profile)
                        : this.page(t, mod),
                  ),
              ),
          )
          .child(Scrollbar.vertical("bc-body").mode("always").absolute().inset_0()),
      );
  }
}
