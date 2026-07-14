// POST /api/publish
// body: { title: string, content: string }  <- content는 format.js가 만든 새 회의록 템플릿(마크다운 유사)
// 필요한 환경변수:
//   CONFLUENCE_BASE_URL   예: https://your-domain.atlassian.net
//   CONFLUENCE_EMAIL      Confluence 로그인 이메일
//   CONFLUENCE_API_TOKEN  Atlassian API 토큰
//   CONFLUENCE_SPACE_KEY  게시할 스페이스 키

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function renderTable(tableLines) {
  if (tableLines.length === 0) return '';
  let idx = 0;
  const headerCells = parseTableRow(tableLines[idx]);
  idx++;
  if (idx < tableLines.length && isTableSeparator(tableLines[idx])) idx++;

  let html = '<table><tbody>\n<tr>' +
    headerCells.map((c) => `<th>${escapeHtml(c)}</th>`).join('') +
    '</tr>\n';

  for (; idx < tableLines.length; idx++) {
    const cells = parseTableRow(tableLines[idx]);
    html += '<tr>' + cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>\n';
  }
  html += '</tbody></table>\n';
  return html;
}

// format.js가 만든 마크다운 유사 회의록 템플릿을 Confluence storage format(HTML 유사)으로 변환
// 지원: "# " -> h2, "## " -> h3, "- " -> ul/li, "| ... |" 표 -> table, 그 외 -> p
function textToStorageHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  const closeListIfOpen = () => {
    if (inList) {
      html += '</ul>\n';
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      closeListIfOpen();
      continue;
    }

    if (line.startsWith('## ')) {
      closeListIfOpen();
      html += `<h3>${escapeHtml(line.slice(3).trim())}</h3>\n`;
      continue;
    }

    if (line.startsWith('# ')) {
      closeListIfOpen();
      html += `<h2>${escapeHtml(line.slice(2).trim())}</h2>\n`;
      continue;
    }

    if (line.startsWith('|')) {
      closeListIfOpen();
      const tableLines = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j].trim());
        j++;
      }
      html += renderTable(tableLines);
      i = j - 1;
      continue;
    }

    if (line.startsWith('- ')) {
      if (!inList) {
        html += '<ul>\n';
        inList = true;
      }
      html += `<li>${escapeHtml(line.slice(2).trim())}</li>\n`;
      continue;
    }

    // 일반 문단
    closeListIfOpen();
    html += `<p>${escapeHtml(line)}</p>\n`;
  }
  closeListIfOpen();
  return html;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  const { title, content } = req.body || {};
  if (!title || !content) {
    return res.status(400).json({ error: '제목과 내용이 모두 필요합니다.' });
  }

  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const apiToken = process.env.CONFLUENCE_API_TOKEN;
  const spaceKey = process.env.CONFLUENCE_SPACE_KEY;

  if (!baseUrl || !email || !apiToken || !spaceKey) {
    return res.status(500).json({
      error: '서버에 CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN / CONFLUENCE_SPACE_KEY 환경변수가 모두 설정되어야 합니다.'
    });
  }

  const storageHtml = textToStorageHtml(content);
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/wiki/rest/api/content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`
      },
      body: JSON.stringify({
        type: 'page',
        title,
        space: { key: spaceKey },
        body: {
          storage: {
            value: storageHtml,
            representation: 'storage'
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({ error: 'Confluence 게시 실패: ' + (data.message || JSON.stringify(data)) });
    }

    const pageUrl = `${baseUrl.replace(/\/$/, '')}/wiki${data._links.webui}`;
    return res.status(200).json({ url: pageUrl, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
