// POST /api/transcribe
// body: { audioBase64: string, encoding?: string, sampleRateHertz?: number, languageCode?: string }
// 필요한 환경변수: GOOGLE_API_KEY (Google Cloud Speech-to-Text REST API용 API 키)
//
// 서비스 계정 키 방식(@google-cloud/speech) 대신, API 키 기반 REST 호출만 사용합니다.
// -> iam.disableServiceAccountKeyCreation 조직 정책이 걸려 있어도 동작합니다.

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

    const transcript = (data.results || [])
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
