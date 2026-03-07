---
title: "Electronで英語学習PDFリーダーを作った話 — 翻訳・ハイライト・メモ -"
emoji: "📖"
type: "tech"
topics: ["electron", "react", "typescript", "deepl", "pdfjs"]
published: false
---

## はじめに

英語の技術書や論文を読むとき、こんな不満を感じたことはないでしょうか。

- 翻訳するたびにブラウザとPDFリーダーを行き来するのが面倒
- ハイライトしたい箇所が多いのに、ツールがバラバラで管理しにくい
- 気になった単語の品詞や例文をその場で確認したい

これらをまとめて解決するために、**EnglishReader** というmacOS向けデスクトップアプリを作りました。

テキストを選択するだけでポップアップが開き、翻訳・ハイライト・メモを1つの画面で完結できる設計です。本記事では、技術スタックの選定理由と主要機能の実装について紹介します。

リポジトリはこちらです。
https://github.com/IwatsukaYura/pdf_reader_english

![EnglishReaderのスクリーンショット](https://storage.googleapis.com/zenn-user-upload/1c9fc9df61b4-20260307.png)

---

## 技術スタックの選定

| レイヤー | 採用技術 | 選定理由 |
|---------|---------|---------|
| デスクトップ | Electron 29 | macOSネイティブAPIとWebの両立 |
| UI | React 18 + TypeScript | コンポーネント単位の状態管理 |
| PDF描画 | PDF.js (react-pdf v7) | 高精度なテキストレイヤー取得 |
| スタイル | Tailwind CSS v3 | 高速なプロトタイピング |
| 状態管理 | Zustand | Reduxより軽量でシンプル |
| ビルド | electron-vite | HMR対応で開発体験が良好 |
| テスト | Vitest + React Testing Library | Viteと統合済みで設定が少ない |

Electronを選んだ最大の理由は、**ファイルシステムへの直接アクセス**です。ハイライトやメモをPDFと同じフォルダの`.annot.json`に保存する設計にしたため、Webアプリでは難しいネイティブなファイル操作が必要でした。

---

## 主要機能の実装

### テキスト選択ポップアップ

PDF上でテキストを選択したとき、翻訳・ハイライト・メモの3アクションを提供するポップアップを表示します。

`mouseup`イベントで`window.getSelection()`を取得し、選択範囲の座標からポップアップの表示位置を計算します。

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
    y: rect.top - 8, // ポップアップをテキストの上に表示
  });
};
```

ポップアップコンポーネントは`position: fixed`で配置し、画面端にはみ出さないようにクランプ処理を入れています。

```typescript
const PopupMenu: React.FC<PopupProps> = ({ text, x, y, onClose }) => {
  const clampedX = Math.min(Math.max(x, POPUP_WIDTH / 2), window.innerWidth - POPUP_WIDTH / 2);

  return (
    <div
      className="fixed z-50 flex gap-1 rounded-lg bg-gray-800 p-1 shadow-xl"
      style={{ left: clampedX, top: y, transform: "translate(-50%, -100%)" }}
    >
      <ActionButton icon={<TranslateIcon />} label="翻訳" onClick={() => handleTranslate(text)} />
      <ActionButton icon={<HighlightIcon />} label="ハイライト" onClick={() => handleHighlight(text)} />
      <ActionButton icon={<MemoIcon />} label="メモ" onClick={() => handleMemo(text)} />
    </div>
  );
};
```

---

### DeepL API + Free Dictionary API による翻訳

文章の翻訳にはDeepL APIを使用しています。単語1語の場合は、Free Dictionary API（無料）から品詞・発音記号・例文も合わせて取得します。

```typescript
const translate = async (text: string): Promise<TranslationResult> => {
  const isSingleWord = !text.includes(" ");

  // 翻訳はDeepL APIへ
  const deepLResult = await fetchDeepL(text);

  // 単語の場合は辞書情報も取得
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
      auth_key: getApiKey(), // Electronのsafeストレージから取得
      text: [text],
      target_lang: "JA",
    }),
  });
  const data = await response.json();
  return { translated: data.translations[0].text };
};
```

APIキーはElectronの`safeStorage`を使って暗号化した上でローカルに保存しており、ソースコードや設定ファイルには含まれません。

---

### ハイライト機能 — ズーム追従と永続化

PDF.jsはテキストレイヤーとCanvasレイヤーが分離しており、ハイライトは**テキストレイヤーのDOM要素にCSSクラスを付与する**方式で実装しています。

ズームが変わるとDOMが再構築されるため、ハイライトはJSON形式で保存しておき、ページ描画後に再適用します。

```typescript
// ハイライトのデータ構造
interface Highlight {
  id: string;
  pageNumber: number;
  text: string;
  color: HighlightColor; // "yellow" | "green" | "pink" | "cyan"
  createdAt: string;
}

// ページ描画後にハイライトを再適用
const applyHighlights = (pageNumber: number) => {
  const highlights = useHighlightStore.getState().getByPage(pageNumber);
  const textLayer = document.querySelector(`[data-page-number="${pageNumber}"] .textLayer`);
  if (!textLayer) return;

  highlights.forEach((h) => {
    const spans = findTextSpans(textLayer, h.text); // テキストに一致するspanを探索
    spans.forEach((span) => span.classList.add(`highlight-${h.color}`));
  });
};
```

保存先はPDFと同じディレクトリの`{filename}.annot.json`です。Electronのメインプロセス経由でファイルを読み書きします。

```typescript
// メインプロセス (main.ts)
ipcMain.handle("save-annotations", async (_, filePath: string, data: unknown) => {
  const annotPath = filePath.replace(/\.pdf$/, ".annot.json");
  await fs.writeFile(annotPath, JSON.stringify(data, null, 2), "utf-8");
});

// レンダラープロセス
const saveAnnotations = async (pdfPath: string, annotations: Annotations) => {
  await window.electron.ipcRenderer.invoke("save-annotations", pdfPath, annotations);
};
```

---

### マークダウン対応メモ

メモはReactのcontrolled inputで管理するシンプルなテキストエリアですが、選択テキストとページ番号が自動で挿入される点がポイントです。

```typescript
const insertMemoTemplate = (text: string, pageNumber: number) => {
  const template = `> ${text}\n\n[p.${pageNumber}] `;
  setMemoContent((prev) => prev + template);
};
```

ページ番号の`[p.X]`をクリックするとそのページへジャンプできるようにしており、後から読み返すときの利便性を高めています。

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

## 設計で工夫した点

**縦スクロール連続表示**

一般的なPDFリーダーはページ単位で切り替えますが、EnglishReaderは全ページを縦に並べてスクロールする設計にしました。英語の本を読み続けるとき、ページ切り替えの断絶感をなくすためです。

react-pdfの`Document`コンポーネント内で`Array.from({ length: numPages })`を使い、全ページの`Page`コンポーネントを一度にレンダリングしています。ページ数が多い場合はIntersection Observerで仮想化を検討できますが、現状は200ページ程度まで問題なく動作しています。

**状態管理をZustandに集約**

ハイライト・メモ・翻訳結果など複数の状態があるため、Zustandのストアごとに関心を分離しました。

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

## まとめ

EnglishReaderは、英語学習のワークフローを1つのアプリに集約することを目指して作りました。

- **テキスト選択ポップアップ**で翻訳・ハイライト・メモを即時実行
- **DeepL + Free Dictionary**で翻訳と辞書情報を一括取得
- **ズーム追従ハイライト**をJSONで永続化
- **ページリンク付きメモ**で読み返しを効率化

Electron + React + TypeScriptの組み合わせは、Webの開発体験をそのままデスクトップアプリに持ち込めるため、フロントエンドエンジニアにとって参入コストが低い選択肢だと感じています。

DeepL APIの無料プランは月500万文字まで使えるため、個人利用であれば費用はほぼかかりません。英語の技術書を読む機会が多い方はぜひ試してみてください。
