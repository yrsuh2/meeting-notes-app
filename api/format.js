// POST /api/format
// body: { transcript: string, date: string }
// Claude API를 호출해서 회의록 양식(HTML)으로 정리한 결과를 반환합니다.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  const { transcript, date } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: '전사된 텍스트가 비어 있습니다.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버에 ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.' });
  }

  const systemPrompt = `당신은 회의 녹취록을 정해진 양식의 회의록으로 정리하는 어시스턴트입니다.
아래 규칙을 반드시 지키세요.

1. 출력은 오직 아래 형식의 순수 텍스트만 작성합니다. HTML이나 마크다운 코드블록(백틱)은 쓰지 마세요.
2. 반드시 아래 형식을 정확히 그대로 따르세요 (줄바꿈, 콜론, "- " 기호 포함).

날짜: ${date || ''}
참석자: 

안건
- (녹취록에서 논의된 주요 안건 1)
- (안건 2)

결정사항
- (결정된 사항 1. 결정된 것이 없으면 "결정된 사항 없음" 한 줄만 작성)

액션 아이템
- (해야 할 작업 1. 담당자가 언급되었다면 "작업내용 (담당: 이름)" 형태로, 언급 안됐으면 작업내용만)

3. "참석자:" 뒤는 절대 채우지 말고 반드시 빈 칸으로 두세요. 사용자가 직접 채울 부분입니다.
4. 녹취록에 실제로 언급되지 않은 내용을 지어내지 마세요. 불명확하면 "논의됨" 정도로만 간단히 적으세요.
5. 구어체 표현(어, 음, 그러니까 등)은 정리 과정에서 자연스럽게 제거하세요.
6. "안건", "결정사항", "액션 아이템" 세 섹션 제목 외에는 다른 제목을 추가하지 마세요.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `다음은 회의 녹취록입니다. 위 규칙에 맞춰 정리해 주세요.\n\n---\n${transcript}\n---` }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Claude API 호출 실패: ' + errText });
    }

    const data = await response.json();
    const formatted = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return res.status(200).json({ formatted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};