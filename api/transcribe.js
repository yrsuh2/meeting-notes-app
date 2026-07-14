// POST /api/transcribe
// body: { audioBase64: string, encoding?: string, sampleRateHertz?: number, languageCode?: string }
// 필요한 환경변수: GOOGLE_API_KEY (Google Cloud Speech-to-Text REST API용 API 키)
//
// 서비스 계정 키 방식(@google-cloud/speech) 대신, API 키 기반 REST 호출만 사용합니다.
// -> iam.disableServiceAccountKeyCreation 조직 정책이 걸려 있어도 동작합니다.
//
// 화자 분리(diarization)를 활성화해서, 가능한 경우 "화자 1: ...", "화자 2: ..." 형태로
// 화자가 구분된 텍스트를 반환합니다. 화자 정보가 없으면 기존처럼 전체 텍스트만 합쳐서 반환합니다.

// data.results 전체에서 words 배열(각 단어의 speakerTag 포함)을 모아
// "화자 N: ..." 형식의 텍스트로 변환합니다. 화자 정보가 없으면 null을 반환합니다.
function buildDiarizedTranscript(results) {
  let allWords = [];
  for (const result of results) {
    const alt = result.alternatives && result.alternatives[0];
    if (alt && Array.isArray(alt.words) && alt.words.length > 0) {
      allWords = allWords.concat(alt.words);
    }
  }

  const hasSpeakerTags = allWords.some(
    (w) => w.speakerTag !== undefined && w.speakerTag !== null
  );
  if (allWords.length === 0 || !hasSpeakerTags) {
    return null;
  }

  const lines = [];
  let currentSpeaker = null;
  let currentWords = [];

  for (const w of allWords) {
    const tag = w.speakerTag;
    if (tag !== currentSpeaker) {
      if (currentWords.length > 0) {
        lines.push(`화자 ${currentSpeaker}: ${currentWords.join(' ')}`);
      }
      currentSpeaker = tag;
      currentWords = [w.word];
    } else {
      currentWords.push(w.word);
    }
  }
  if (currentWords.length > 0) {
    lines.push(`화자 ${currentSpeaker}: ${currentWords.join(' ')}`);
  }

  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  try {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GOOGLE_API_KEY 환경변수가 설정되어 있지 않습니다.",
      });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    let {
      audioBase64,
      encoding = "LINEAR16",
      sampleRateHertz = 16000,
      languageCode = "ko-KR",
    } = body || {};

    if (!audioBase64) {
      return res.status(400).json({ error: "audioBase64 값이 없습니다." });
    }

    // FileReader.readAsDataURL() 결과("data:audio/webm;base64,xxxx")를
    // 그대로 보낸 경우 접두사를 제거해서 순수 base64만 남긴다.
    const commaIndex = audioBase64.indexOf(",");
    if (audioBase64.startsWith("data:") && commaIndex !== -1) {
      audioBase64 = audioBase64.slice(commaIndex + 1);
    }

    const googleResponse = await fetch(
      "https://speech.googleapis.com/v1/speech:recognize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          config: {
            encoding,
            sampleRateHertz: Number(sampleRateHertz),
            languageCode,
            model: "latest_long",
            enableAutomaticPunctuation: true,
            audioChannelCount: 1,
            diarizationConfig: {
              enableSpeakerDiarization: true,
              minSpeakerCount: 2,
              maxSpeakerCount: 6,
            },
          },
          audio: {
            content: audioBase64,
          },
        }),
      }
    );

    const data = await googleResponse.json();

    if (!googleResponse.ok) {
      console.error("Google STT error:", data);
      return res.status(googleResponse.status).json({
        error: "Google STT 변환 중 오류가 발생했습니다.",
        detail: data.error?.message || data,
      });
    }

    const results = data.results || [];
    const diarizedTranscript = buildDiarizedTranscript(results);

    const transcript =
      diarizedTranscript !== null
        ? diarizedTranscript
        : results
            .map((result) => result.alternatives?.[0]?.transcript || "")
            .filter(Boolean)
            .join("\n");

    return res.status(200).json({ transcript });
  } catch (error) {
    console.error("STT 처리 오류:", error);
    return res.status(500).json({
      error: "STT 처리 중 서버 오류가 발생했습니다.",
      detail: error.message,
    });
  }
}
