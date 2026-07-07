// POST /api/publish
// body: { title: string, content: string }  <- content는 format.js가 만든 순수 텍스트 회의록
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

// format.js가 만든 순수 텍스트 회의록을 Confluence storage format(HTML 유사)으로 변환
function textToStorageHtml(text) {
  const lines = text.split('\n');
  let html = '<h2>회의록</h2>\n';
  let inList = false;

  const closeListIfOpen = () => {
    if (inList) {
      html += '</ul>\n';
      inList = false;
    }
  };

  for (let rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      closeListIfOpen();
      continue;
    }

    if (line.startsWith('날짜:') || line.startsWith('참석자:')) {
      closeListIfOpen();
      const [label, ...rest] = line.split(':');
      html += `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(rest.join(':').trim())}</p>\n`;
      continue;
    }

    if (line === '안건' || line === '결정사항' || line === '액션 아이템') {
      closeListIfOpen();
      html += `<h3>${escapeHtml(line)}</h3>\n`;
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

    // 그 외 일반 텍스트 줄
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