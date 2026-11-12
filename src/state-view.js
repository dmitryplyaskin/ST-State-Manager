/** Readable, schema-independent state rendering. All model text stays text. */
const labels = {
  time: "Время", location: "Место", weather: "Погода", characters: "Персонажи",
  possessions: "Предметы", facts: "Факты", present: "В сцене", state: "Состояние",
  action: "Сейчас", dialogue: "Реплика", clothing: "Одежда", inventory: "Вещи",
  name: "Имя", description: "Описание", flags: "Флаги", relationships: "Отношения",
};
const fieldLabel = key => Object.hasOwn(labels, key) ? labels[key] : key;

function text(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function valueView(value, depth) {
  if (value === null) return text("span", "Не указано");
  if (typeof value !== "object") return text("span", typeof value === "boolean" ? value ? "Да" : "Нет" : String(value));
  if (depth > 6) {
    const pre = text("pre", JSON.stringify(value, null, 2));
    pre.className = "stsm-code";
    return pre;
  }
  if (Array.isArray(value)) {
    if (!value.length) return text("span", "Нет записей");
    const list = document.createElement("ul");
    for (const item of value) {
      const entry = document.createElement("li");
      entry.append(valueView(item, depth + 1));
      list.append(entry);
    }
    return list;
  }
  const entries = Object.entries(value);
  if (!entries.length) return text("span", "Нет данных");
  const list = document.createElement("dl");
  for (const [key, item] of entries) {
    const description = document.createElement("dd");
    description.append(valueView(item, depth + 1));
    list.append(text("dt", fieldLabel(key)), description);
  }
  return list;
}

export function renderStateView(container, data) {
  container.replaceChildren();
  for (const [key, value] of Object.entries(data)) {
    const section = document.createElement("section");
    section.className = "stsm-state-section";
    section.append(text("h5", fieldLabel(key)), valueView(value, 0));
    container.append(section);
  }
}
