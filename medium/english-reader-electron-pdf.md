---
title: "Building an English Learning PDF Reader with Electron — Translation, Highlights, and Notes"
tags: ["electron", "react", "typescript", "pdf"]
published: true
canonicalUrl: ""
---

# Building an English Learning PDF Reader with Electron — Translation, Highlights, and Notes

## Introduction

Have you ever felt frustrated when reading English technical books or papers?

- Constantly switching between a browser and a PDF reader just to translate a sentence
- Highlights scattered across different tools, making them hard to manage
- Wanting to check a word's part of speech or example sentences right then and there

To solve all of these at once, I built **EnglishReader** — a macOS desktop app that lets you select text and instantly translate, highlight, or take notes, all within a single popup. In this article, I'll walk through why I chose each technology and how the key features are implemented.

Repository: https://github.com/IwatsukaYura/pdf_reader_english

![EnglishReader screenshot](https://storage.googleapis.com/zenn-user-upload/1c9fc9df61b4-20260307.png)

---

## Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Desktop | Electron 29 | Access both macOS native APIs and the Web platform |
| UI | React 18 + TypeScript | Component-based state management |
| PDF rendering | PDF.js (react-pdf v7) | Accurate text layer extraction |
| Styling | Tailwind CSS v3 | Rapid prototyping |
| State management | Zustand | Lighter and simpler than Redux |
| Build | electron-vite | Great DX with HMR support |
| Testing | Vitest + React Testing Library | Minimal configuration with Vite integration |

The main reason I chose Electron is **direct filesystem access**. Highlights and notes are saved to a `.annot.json` file in the same folder as the PDF, which requires native file I/O that would be impractical in a pure web app.

---

## Key Feature Implementations

### Text Selection Popup

When the user selects text on a PDF, a popup appears offering three actions: translate, highlight, and add a note.

I listen to the `mouseup` event, grab `window.getSelection()`, and compute the popup position from the selection's bounding rect.

```typescript
const handleMouseUp = (e: MouseEvent) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    setPopup(null);
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  setPopup({
    text: selectedText,
    x: rect.left + rect.width / 2,
    y: rect.top - 8, // display popup above the selected text
  });
};
```

The popup component is positioned with `position: fixed` and clamped so it never overflows the screen edge.

```typescript
const PopupMenu: React.FC<PopupProps> = ({ text, x, y, onClose }) => {
  const clampedX = Math.min(Math.max(x, POPUP_WIDTH / 2), window.innerWidth - POPUP_WIDTH / 2);

  return (
    <div
      className="fixed z-50 flex gap-1 rounded-lg bg-gray-800 p-1 shadow-xl"
      style={{ left: clampedX, top: y, transform: "translate(-50%, -100%)" }}
    >
      <ActionButton icon={<TranslateIcon />} label="Translate" onClick={() => handleTranslate(text)} />
      <ActionButton icon={<HighlightIcon />} label="Highlight" onClick={() => handleHighlight(text)} />
      <ActionButton icon={<MemoIcon />} label="Note" onClick={() => handleMemo(text)} />
    </div>
  );
};
```

---

### Translation with DeepL API + Free Dictionary API

Sentences are translated using the DeepL API. For single words, the Free Dictionary API (free tier) is also called to fetch the part of speech, pronunciation, and example sentences.

```typescript
const translate = async (text: string): Promise<TranslationResult> => {
  const isSingleWord = !text.includes(" ");

  // Always translate via DeepL
  const deepLResult = await fetchDeepL(text);

  // For single words, also fetch dictionary info
  if (isSingleWord) {
    const dictResult = await fetchDictionary(text);
    return { ...deepLResult, dictionary: dictResult };
  }

  return deepLResult;
};

const fetchDeepL = async (text: string): Promise<{ translated: string }> => {
  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_key: getApiKey(), // retrieved from Electron's safeStorage
      text: [text],
      target_lang: "JA",
    }),
  });
  const data = await response.json();
  return { translated: data.translations[0].text };
};
```

The API key is encrypted with Electron's `safeStorage` and stored locally — it never appears in source code or config files.

---

### Highlights — Zoom-aware and Persistent

PDF.js separates the text layer from the canvas layer. Highlights are implemented by **adding a CSS class to the text layer DOM elements** rather than drawing on the canvas.

Since the DOM is rebuilt whenever the zoom level changes, highlights are stored as JSON and re-applied after each page render.

```typescript
// Highlight data structure
interface Highlight {
  id: string;
  pageNumber: number;
  text: string;
  color: HighlightColor; // "yellow" | "green" | "pink" | "cyan"
  createdAt: string;
}

// Re-apply highlights after a page is rendered
const applyHighlights = (pageNumber: number) => {
  const highlights = useHighlightStore.getState().getByPage(pageNumber);
  const textLayer = document.querySelector(`[data-page-number="${pageNumber}"] .textLayer`);
  if (!textLayer) return;

  highlights.forEach((h) => {
    const spans = findTextSpans(textLayer, h.text); // find spans matching the text
    spans.forEach((span) => span.classList.add(`highlight-${h.color}`));
  });
};
```

Annotations are saved to `{filename}.annot.json` in the same directory as the PDF, via the Electron main process.

```typescript
// Main process (main.ts)
ipcMain.handle("save-annotations", async (_, filePath: string, data: unknown) => {
  const annotPath = filePath.replace(/\.pdf$/, ".annot.json");
  await fs.writeFile(annotPath, JSON.stringify(data, null, 2), "utf-8");
});

// Renderer process
const saveAnnotations = async (pdfPath: string, annotations: Annotations) => {
  await window.electron.ipcRenderer.invoke("save-annotations", pdfPath, annotations);
};
```

---

### Markdown-aware Notes

Notes are managed as a simple controlled textarea, but the selected text and current page number are automatically inserted as a template.

```typescript
const insertMemoTemplate = (text: string, pageNumber: number) => {
  const template = `> ${text}\n\n[p.${pageNumber}] `;
  setMemoContent((prev) => prev + template);
};
```

Clicking a `[p.X]` reference in a note jumps directly to that page, making it easy to revisit specific passages later.

```typescript
const handleMemoClick = (e: React.MouseEvent<HTMLDivElement>) => {
  const target = e.target as HTMLElement;
  const match = target.textContent?.match(/\[p\.(\d+)\]/);
  if (match) {
    const page = parseInt(match[1], 10);
    scrollToPage(page);
  }
};
```

---

## Design Decisions

**Continuous vertical scroll**

Most PDF readers switch between pages one at a time. EnglishReader instead renders all pages stacked vertically for uninterrupted scrolling — eliminating the jarring page-flip experience when reading continuously.

I use `Array.from({ length: numPages })` inside react-pdf's `Document` component to render all `Page` components at once. For very large documents, virtualization with Intersection Observer is a natural next step, but in practice the app handles up to ~200 pages without issues.

**Zustand stores with separated concerns**

Since there are multiple independent state domains — highlights, notes, and translation results — I created a separate Zustand store for each to keep concerns isolated.

```typescript
// stores/highlightStore.ts
interface HighlightStore {
  highlights: Highlight[];
  add: (highlight: Highlight) => void;
  remove: (id: string) => void;
  getByPage: (pageNumber: number) => Highlight[];
}

export const useHighlightStore = create<HighlightStore>((set, get) => ({
  highlights: [],
  add: (highlight) => set((state) => ({ highlights: [...state.highlights, highlight] })),
  remove: (id) => set((state) => ({ highlights: state.highlights.filter((h) => h.id !== id) })),
  getByPage: (pageNumber) => get().highlights.filter((h) => h.pageNumber === pageNumber),
}));
```

---

## Summary

EnglishReader brings together the entire English reading workflow into a single app:

- **Text selection popup** for instant translation, highlighting, and note-taking
- **DeepL + Free Dictionary** for translations and word-level dictionary info in one call
- **Zoom-aware highlights** persisted as JSON
- **Page-linked notes** for efficient review

The Electron + React + TypeScript stack lets you bring the web development experience directly to a desktop app, making it a low barrier entry point for frontend engineers.

DeepL's free plan allows up to 5 million characters per month, so for personal use the cost is essentially zero. If you frequently read English technical books, give it a try.
