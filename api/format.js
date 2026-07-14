// POST /api/format
// body: { transcript: string, participants?: string, memo?: string, date?: string, dateTime?: string }
// Claude API를 호출해서 정해진 회의록 템플릿(JSON: {title, minutes})으로 정리한 결과를 반환합니다.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  const { transcript, participants, memo, date, dateTime } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: '전사된 텍스트가 비어 있습니다.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버에 ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.' });
  }

  const participantsText = (participants || '').trim();
  const memoText = (memo || '').trim();
  const dateTimeText = (dateTime && dateTime.trim()) ? dateTime.trim() : (date || '').trim();
  const fallbackTitle = `${(date || '').trim()} 회의록`.trim() || '회의록';

  const systemPrompt = `당신은 회의 녹취록과 보조 메모를 바탕으로 정해진 형식의 회의록을 작성하는 어시스턴트입니다.

반드시 아래 JSON 형식으로만 응답하세요. JSON 외의 다른 텍스트, 설명, 코드블록 표시(백틱)를 절대 포함하지 마세요.

{
  "title": "회의 내용을 기반으로 한 간결한 페이지 제목 (날짜 제외)",
  "minutes": "아래 템플릿 전체를 담은 하나의 문자열 (줄바꿈은 \\n으로 표현)"
}

"minutes" 안에는 반드시 아래 마크다운 템플릿을 정확한 구조로 채워 넣으세요.

# 회의 개요

- 회의명: (내용)
- 일시: ${dateTimeText || '(정보 없음)'}
- 참석자: ${participantsText || '(정보 없음)'}
- 목적: (한 문장)

# 주요 논의사항

## 1. (논의 제목)
(내용)

## 2. (논의 제목)
(내용)

(논의 항목 수는 실제 내용에 맞게 조정하세요.)

# 결론

(확정된 내용 중심으로 작성)

# 액션 아이템

| 액션 | 확인/확정 필요 사항 | 확인/확정일자 | 비고 |
|---|---|---|---|
| (내용) | (내용) | (내용) | (내용) |

작성 규칙:
1. "회의명"은 녹취록과 메모를 바탕으로 간결하게 작성합니다.
2. "일시"는 위에 주어진 값(${dateTimeText || '정보 없음'})을 그대로 사용합니다. 임의로 바꾸지 마세요.
3. "참석자"는 위에 주어진 값(${participantsText || '정보 없음'})이 있으면 그대로 사용하고, 없으면 "확인 필요"로 표시합니다.
4. "목적"은 회의 내용을 근거로 한 문장으로 정리합니다.
5. "회의 중 메모"가 주어지면 이는 사용자가 직접 확인한 신뢰할 수 있는 보조 정보이며, 녹취록(STT)의 오인식보다 우선합니다. 메모와 녹취록 내용이 다르면 메모를 기준으로 자연스럽게 보정하세요.
6. 실제로 언급되거나 메모에 적힌 내용 외에는 절대 지어내지 마세요. 불명확한 내용은 "확인 필요"로 표시하세요.
7. 녹취록에 "화자 1:", "화자 2:"와 같은 화자 구분이 포함되어 있으면, 이를 발언 흐름과 논의 맥락 파악에 참고하세요. 단, 화자 번호를 실제 참석자 이름으로 추정하거나 단정하지 마세요.
8. 액션 아이템은 반드시 마크다운 표 형식으로 작성합니다. 확인/확정일자가 불명확하면 "확인 필요"로, 담당자나 액션이 불명확하면 비고란에 "담당자 확인 필요" 등으로 적으세요. 지어내지 마세요.
9. 위 템플릿 구조 외의 불필요한 설명문을 추가하지 마세요.`;

  const userMessageParts = [
    `다음은 회의 녹취록입니다. 위 규칙과 템플릿에 맞춰 정리해 주세요.`,
    `\n\n[녹취록]\n${transcript}`
  ];
  if (memoText) {
    userMessageParts.push(`\n\n[회의 중 메모 - STT보다 신뢰할 수 있는 보조 정보]\n${memoText}`);
  }

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
        max_tokens: 3000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessageParts.join('') }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Claude API 호출 실패: ' + errText });
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    // 코드블록 표시 제거 (```json, ``` 등) 후 JSON 파싱 시도
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    let title = '';
    let minutes = '';

    try {
      const parsed = JSON.parse(cleaned);
      title = (parsed.title || '').trim() || fallbackTitle;
      minutes = (parsed.minutes || '').trim() || cleaned;
    } catch (parseErr) {
      // JSON 파싱 실패 시: 전체 텍스트를 회의록 본문으로 사용, 제목은 날짜 기반 기본값
      title = fallbackTitle;
      minutes = cleaned;
    }

    return res.status(200).json({ title, formatted: minutes, minutes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
