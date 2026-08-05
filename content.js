(async () => {
  const allowedPaths = [
    "/dashboard/works/novels",
    "/dashboard/works/novels/series"
  ];
  if (!allowedPaths.includes(location.pathname)) {
    console.log("pixivダッシュボードの小説作品一覧・シリーズ一覧ページでのみ実行可能です。");
    return;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sanitizeFileName(name) {
    let safe = name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\u0000-\u001F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/, "");
    if (!safe) safe = "無題";
    return safe.slice(0, 100);
  }

  function extractIdsFromNovelList() {
    const links = [...document.querySelectorAll('a[href*="/novel/show.php?id="]')];
    return [...new Set(
      links
        .map(a => {
          const url = new URL(a.href);
          return url.searchParams.get("id");
        })
        .filter(Boolean)
    )];
  }

  function extractSeriesLinksFromPage() {
    const links = [...document.querySelectorAll('a[href*="/novel/series/"]')];
    const map = new Map();
    for (const a of links) {
      const match = a.href.match(/\/novel\/series\/(\d+)/);
      if (!match) continue;
      const seriesId = match[1];
      const title = a.textContent.trim();
      if (title && !map.has(seriesId)) {
        map.set(seriesId, title);
      }
    }
    return map;
  }

  async function getSeriesNovelIds(seriesId, limit = 30) {
    const res = await fetch(
      `https://www.pixiv.net/ajax/novel/series_content/${seriesId}?limit=${limit}&lang=ja`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.message || "APIエラー");
    const novels = json.body?.page?.seriesContents ?? [];
    return novels.map(n => String(n.id));
  }

  // --- idの収集(id -> 所属シリーズ名のマップも作る) ---
  let ids = [];
  const idToSeriesName = new Map(); // id -> シリーズ名(単発作品はエントリなし)

  if (location.pathname === "/dashboard/works/novels") {
    ids = extractIdsFromNovelList();
  } else {
    const seriesMap = extractSeriesLinksFromPage(); // seriesId -> seriesTitle
    const collected = [];
    for (const [seriesId, seriesTitle] of seriesMap) {
      try {
        const novelIds = await getSeriesNovelIds(seriesId);
        for (const novelId of novelIds) {
          idToSeriesName.set(novelId, seriesTitle);
        }
        collected.push(...novelIds);
      } catch (err) {
        console.error(`series=${seriesId} の取得に失敗しました:`, err);
      }
      await sleep(500);
    }
    ids = [...new Set(collected)];
  }
  console.log("収集したid:", ids);

  // --- 本文取得とzip化(フォルダ分け対応) ---
  const zip = new JSZip();
  const usedNames = new Map(); // フォルダごとに重複チェック("" はルート扱い)
  const failed = [];

  for (const id of ids) {
    try {
      const response = await fetch(`/novel/mod.php?id=${id}&mode=mod_info`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const title = doc.querySelector('input[placeholder="タイトル"]')?.value ?? "";
      const body = doc.querySelector('textarea[aria-label="本文"]')?.value ?? "";

      if (!title && !body) {
        throw new Error("タイトル・本文が取得できませんでした(構造変更の可能性)");
      }

      const seriesName = idToSeriesName.get(id) ?? null;
      const folderName = seriesName ? sanitizeFileName(seriesName) : "";
      const usedKey = folderName; // フォルダ単位で重複管理

      if (!usedNames.has(usedKey)) usedNames.set(usedKey, new Set());
      const nameSet = usedNames.get(usedKey);

      let fileName = sanitizeFileName(title) || id;
      if (nameSet.has(fileName)) fileName = `${fileName}_${id}`;
      nameSet.add(fileName);

      if (folderName) {
        zip.folder(folderName).file(`${fileName}.txt`, body);
      } else {
        zip.file(`${fileName}.txt`, body);
      }
    } catch (err) {
      console.error(`id=${id} の取得に失敗しました:`, err);
      failed.push({ id, reason: err.message });
    }
    await sleep(500);
  }

  const successCount = ids.length - failed.length;

  if (successCount > 0) {
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pixiv_novels.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const message = failed.length === 0
    ? `${ids.length}作品中 ${successCount}作品を保存しました。`
    : `${ids.length}作品中 ${successCount}作品を保存しました (${failed.length}作品取得できませんでした)`;

  console.log(message, failed);
  alert(message);
})();