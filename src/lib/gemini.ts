import { GoogleGenAI, Type } from "@google/genai";
import { Region } from "../types";

export interface RawRegion {
  type: "bubble" | "sfx";
  originalText: string;
  translatedText: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  angle: number;
  textColor: string;
  strokeColor: string;
  strokeWidth: number;
  bgColor?: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  lineHeight: number;
}

export async function generateInpaint(base64Image: string, mimeType: string, customApiKey?: string): Promise<string> {
  const key = customApiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("API Key is required");
  }
  const ai = new GoogleGenAI({ apiKey: key });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        {
          text: 'Remove all text, letters, speech bubbles, and sound effects from this image patch. Seamlessly restore the background underneath without altering the remaining art style or surrounding objects. Output only the cleaned image.',
        },
      ],
    },
    config: {
      imageConfig: {
        aspectRatio: '1:1'
      }
    }
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
    }
  }

  throw new Error("Failed to generate inpaint image.");
}

export async function processMangaPages(pages: { id: string, base64Image: string, mimeType: string }[], customApiKey?: string, customInstructions?: string, translateJapanese?: boolean, translateSfx?: boolean): Promise<{ id: string, regions: RawRegion[] }[]> {
  const key = customApiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("API Key is required");
  }
  const ai = new GoogleGenAI({ apiKey: key });

  let textPrompt = `You are an expert manga translator and professional typesetter.
I am providing ${pages.length} manga page(s). Analyze EACH page independently.
For each page, detect all speech bubbles, narrative text, and sound effects (SFX).

1. Identify the original text.
2. ${translateJapanese ? "Translate it accurately and naturally to Arabic. Prioritize smooth, colloquial or literary flow depending on context." : "Extract the text and keep the 'translatedText' field as the original text (do NOT translate)."}
3. Determine the bounding box coordinates [ymin, xmin, ymax, xmax] scaled to 0-1000.
4. Categorize as 'bubble' (for standard conversation/speech bubbles and thought bubbles) or 'sfx' (for sound effects, ambient noises drawn as art, floating text outside bubbles). Be very strict about this distinction! SFX should only be text that represents sound. ${!translateSfx ? "\nIGNORE ALL 'sfx' (sound effects) COMPLETELY. Do not add them to the regions array." : ""}
5. typesetter decisions: 
    - angle: suggested text rotation in degrees (e.g., 0 for normal, angled for SFX).
    - textColor: hex color code.
    - strokeColor: hex color code for the text outline (critical for SFX or hiding original text).
    - strokeWidth: outline thickness (e.g. 0 to 10).
    - fontFamily: choose exactly from: "Cairo", "Tajawal", "Marhey", "Aref Ruqaa", "El Messiri", "Amiri", "Changa", "Harmattan", "Katibeh", "Lalezar", "Lemonada", "Mada", "Markazi Text", "Reem Kufi", "Rakkas", "Almarai". (e.g. Marhey/Katibeh/Changa/Lemonada for informal conversation bubbles, Aref Ruqaa/Lalezar/Rakkas for SFX or angry shouts, Cairo/Almarai/Tajawal for formal narration or thoughts). VARY THE FONTS ACROSS DIFFERENT BUBBLES DEPENDING ON THE TONE AND CONTEXT.
    - fontSize: suggest a base size (e.g. 24-72).
    - fontWeight: 'normal', 'bold', '800', etc.
    - fontStyle: 'normal' or 'italic'.
    - textAlign: 'center', 'right', 'left' (mostly center for bubbles).
    - lineHeight: usually 1.2 to 1.5.

${customInstructions ? `Additional Instructions from User:\n${customInstructions}\n` : ""}
Return ONLY a JSON array of objects, one for each page, in the EXACT order they were provided.
Schema: [ { "pageIndex": 0, "regions": [ ... ] } ]`;

  const contents: any[] = [
    {
      text: textPrompt
    }
  ];

  pages.forEach(p => {
    contents.push({
      inlineData: {
        data: p.base64Image.split(",")[1] || p.base64Image,
        mimeType: p.mimeType,
      }
    });
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            pageIndex: { type: Type.INTEGER },
            regions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING, description: "either 'bubble' or 'sfx'" },
                  originalText: { type: Type.STRING },
                  translatedText: { type: Type.STRING },
                  ymin: { type: Type.NUMBER, description: "0-1000" },
                  xmin: { type: Type.NUMBER, description: "0-1000" },
                  ymax: { type: Type.NUMBER, description: "0-1000" },
                  xmax: { type: Type.NUMBER, description: "0-1000" },
                  angle: { type: Type.NUMBER, description: "degrees, usually 0 for bubbles" },
                  textColor: { type: Type.STRING, description: "hex color" },
                  strokeColor: { type: Type.STRING, description: "hex color for text outline" },
                  strokeWidth: { type: Type.NUMBER },
                  bgColor: { type: Type.STRING, description: "Hex bg color or transparent" },
                  fontFamily: { type: Type.STRING, description: "Cairo, Tajawal, Marhey, or Aref Ruqaa" },
                  fontSize: { type: Type.NUMBER },
                  fontWeight: { type: Type.STRING },
                  fontStyle: { type: Type.STRING },
                  textAlign: { type: Type.STRING },
                  lineHeight: { type: Type.NUMBER }
                },
                required: ["type", "originalText", "translatedText", "ymin", "xmin", "ymax", "xmax", "angle", "textColor", "strokeColor", "strokeWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "textAlign", "lineHeight"]
              }
            }
          },
          required: ["pageIndex", "regions"]
        }
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No text returned from Gemini");

  try {
    const rawData = JSON.parse(text) as { pageIndex: number, regions: RawRegion[] }[];
    return rawData.map((item, idx) => ({
      id: pages[Math.min(idx, pages.length - 1)].id,
      regions: item.regions || []
    }));
  } catch (error) {
    console.error("Failed to parse JSON", text);
    throw new Error("Failed to parse AI response");
  }
}
