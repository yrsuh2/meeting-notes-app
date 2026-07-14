// POST /api/transcribe
// body: { audioBase64: string, encoding?: string, sampleRateHertz?: number, languageCode?: string,
//         minSpeakerCount?: number, maxSpeakerCount?: number }
// 필요한 환경변수: GOOGLE_API_KEY (Google Cloud Speech-to-Text REST API용 API 키)
//
// 서비스 계정 키 방식(@google-cloud/speech) 대신, API 키 기반 REST 호출만 사용합니다.
// -> iam.disableServiceAccountKeyCreation 조직 정책이 걸려 있어도 동작합니다.
//
// 화자 분리(diarization)를 활성화하되, 실제로 감지된 화자가 2명 이상일 때만
// "화자 1: ...", "화자 2: ..." 라벨을 붙입니다. 전부 한 명으로 감지되거나
// 화자 정보가 없으면 라벨 없이 일반 텍스트만 반환합니다.

// speakerTag(또는 speakerLabel/speaker_label) 값을 정규화합니다.
// "speaker_1" 같은 접두사가 붙어 오는 경우도 처리합니다. 값이 없으면 null.
function normalizeSpeakerTag(wordInfo) {
  const tag =
    wordInfo.speakerTag ??
    wordInfo.speakerLabel ??
    wordInfo.speaker_label ??
    null;

  if (tag === null || tag === undefined || tag === "") {
    return null;
  }

  return String(tag).replace(/^speaker_/i, "");
}

// "화자 undefined:" 문구와 "▁" 문자, 중복 공백을 정리합니다.
// speakerTag가 없어 사용하는 fallback transcript에도 동일하게 적용합니다.
function cleanPlainTranscript(text) {
  return String(text || "")
    .replace(/화자 undefined:\s*/g, "")
    .replace(/▁/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDiarizedText(tokens) {
  return cleanPlainTranscript(tokens.join(""));
}

// 화자 분리 결과가 있고 실제 감지된 화자가 2명 이상일 때만 "화자 N: ..." 형식으로,
// 그 외에는 일반 텍스트(fallback)를 반환합니다.
function buildSpeakerTranscript(results) {
  const resultWithWords = [...(results || [])]
    .reverse()
    .find((result) => result.alternatives?.[0]?.words?.length);

  const words = resultWithWords?.alternatives?.[0]?.words || [];

  const fallbackTranscript = cleanPlainTranscript(
    (results || [])
      .map((result) => result.alternatives?.[0]?.transcript || "")
      .filter(Boolean)
      .join("\n")
  );

  const taggedWords = words.filter((wordInfo) => normalizeSpeakerTag(wordInfo));

  if (!taggedWords.length) {
    return fallbackTranscript;
  }

  const uniqueSpeakers = new Set(
    taggedWords
      .map((wordInfo) => normalizeSpeakerTag(wordInfo))
      .filter(Boolean)
  );

  // 실제 감지된 화자가 1명뿐이면 화자 라벨을 붙이지 않음
  if (uniqueSpeakers.size < 2) {
    return fallbackTranscript || cleanDiarizedText(taggedWords.map((wordInfo) => wordInfo.word || ""));
  }

  const lines = [];
  let currentSpeaker = null;
  let currentTokens = [];

  for (const wordInfo of taggedWords) {
    const speakerTag = normalizeSpeakerTag(wordInfo);
    const word = wordInfo.word || "";

    if (!speakerTag || !word) continue;

    if (currentSpeaker !== null && speakerTag !== currentSpeaker) {
      const text = cleanDiarizedText(currentTokens);
      if (text) lines.push(`화자 ${currentSpeaker}: ${text}`);
      currentTokens = [];
    }

    currentSpeaker = speakerTag;
    currentTokens.push(word);
  }

  if (currentTokens.length) {
    const text = cleanDiarizedText(currentTokens);
    if (text) lines.push(`화자 ${currentSpeaker}: ${text}`);
  }

  return lines.join("\n").trim() || fallbackTranscript;
}

export default async function handler(req, res) {
  console.log("TRANSCRIBE_VERSION: diarization-smart-fallback-v1");

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
      minSpeakerCount,
      maxSpeakerCount,
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
              minSpeakerCount: Number(minSpeakerCount) || 2,
              maxSpeakerCount: Number(maxSpeakerCount) || 4,
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
    const transcript = buildSpeakerTranscript(results);

    return res.status(200).json({ transcript });
  } catch (error) {
    console.error("STT 처리 오류:", error);
    return res.status(500).json({
      error: "STT 처리 중 서버 오류가 발생했습니다.",
      detail: error.message,
    });
  }
}
