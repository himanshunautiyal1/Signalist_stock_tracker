import { inngest } from "@/lib/inngest/client";
import { PERSONALIZED_WELCOME_EMAIL_PROMPT } from "@/lib/inngest/prompts";
import { sendWelcomeEmail } from "@/lib/nodemailer";

export const sendSignUpEmail = inngest.createFunction(
  { id: "sign-up-email" },
  { event: "app/user.created" },
  async ({ event, step }) => {
    const userProfile = `
      - Country: ${event.data.country}
      - Investment goals: ${event.data.investmentGoals}
      - Risk tolerance: ${event.data.riskTolerance}
      - Preferred industry: ${event.data.preferredIndustry}
    `;

    const prompt = PERSONALIZED_WELCOME_EMAIL_PROMPT.replace(
      "{{userProfile}}",
      userProfile
    );

    const fallbackText =
      "Thanks for joining Signalist. You now have the tools to track markets and make smarter moves.";

    // ⬇️ Replace AI inference with direct Gemini API call
    const generatedIntro = await step.run("call-gemini-api", async () => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }),
        }
      );

      const json = await res.json();

      const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
      return part || fallbackText;
    });

    const {
      data: { email, name },
    } = event;

    await step.run("send-welcome-email", async () => {
      return await sendWelcomeEmail({
        email,
        name,
        intro: generatedIntro,
      });
    });

    return {
      success: true,
      message: "Welcome email sent successfully",
    };
  }
);
