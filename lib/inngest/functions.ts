import dotenv from "dotenv";
dotenv.config();

import { inngest } from "@/lib/inngest/client";
import {
  NEWS_SUMMARY_EMAIL_PROMPT,
  PERSONALIZED_WELCOME_EMAIL_PROMPT,
} from "@/lib/inngest/prompts";
import { sendNewsSummaryEmail, sendWelcomeEmail } from "@/lib/nodemailer";
import { getAllUsersForNewsEmail } from "@/lib/actions/user.actions";
import { getWatchlistSymbolsByEmail } from "@/lib/actions/watchlist.actions";
import { getNews } from "@/lib/actions/finnhub.actions";
import { getFormattedTodayDate } from "@/lib/utils";

// ...existing code...
interface UserForNewsEmail {
  email: string;
  name?: string;
  // Add any other fields you expect from getAllUsersForNewsEmail
}
// ...existing code...

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

export const sendDailyNewsSummary = inngest.createFunction(
  { id: "daily-news-summary" },
  [{ event: "app/send.daily.news" }, { cron: "0 12 * * *" }],
  //[{ event: "app/send.daily.news" }, { cron: "* * * * *" }],
  async ({ step }) => {
    console.log("🟢 Running daily-news-summary...");

    // Step 1: Get all users
    const users = await step.run("get-all-users", getAllUsersForNewsEmail);
    console.log("👥 Users fetched:", users?.length);

    if (!users || users.length === 0) {
      console.warn("⚠️ No users found for news email");
      return { success: false, message: "No users found for news email" };
    }

    // Step 2: Fetch personalized news for each user
    const results = await step.run("fetch-user-news", async () => {
      const perUser: Array<{
        user: UserForNewsEmail;
        articles: MarketNewsArticle[];
      }> = [];

      for (const user of users as UserForNewsEmail[]) {
        try {
          const symbols = await getWatchlistSymbolsByEmail(user.email);
          let articles = await getNews(symbols);
          articles = (articles || []).slice(0, 6);

          if (!articles || articles.length === 0) {
            articles = await getNews();
            articles = (articles || []).slice(0, 6);
          }

          perUser.push({ user, articles });
        } catch (e) {
          console.error("❌ Error preparing user news for", user.email, e);
          perUser.push({ user, articles: [] });
        }
      }

      return perUser;
    });

    // Step 3: Summarize news via Gemini API manually
    const userNewsSummaries: {
      user: UserForNewsEmail;
      newsContent: string | null;
    }[] = [];

    // Step #3: Summarize news via Gemini API
    for (const { user, articles } of results) {
      try {
        const prompt = NEWS_SUMMARY_EMAIL_PROMPT.replace(
          "{{newsData}}",
          JSON.stringify(articles, null, 2)
        );

        const newsContent = await step.run(
          `summarize-news-${user.email}`,
          async () => {
            // 🔍 Log the actual API key being used
            //    console.log(
            //       "🔐 GEMINI_API_KEY in daily-news-summary:",
            //       process.env.GEMINI_API_KEY
            //     );

            if (!process.env.GEMINI_API_KEY) {
              throw new Error("❌ Missing GEMINI_API_KEY in environment");
            }

            const model = "gemini-2.5-flash-lite";

            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  contents: [
                    {
                      role: "user",
                      parts: [{ text: prompt }],
                    },
                  ],
                }),
              }
            );

            if (!res.ok) {
              console.error(
                `Gemini API error for ${user.email}:`,
                await res.text()
              );
              return null;
            }

            const json = await res.json();
            return (
              json.candidates?.[0]?.content?.parts?.[0]?.text ??
              "No market news."
            );
          }
        );

        userNewsSummaries.push({ user, newsContent });
      } catch (e) {
        console.error("Failed to summarize news for:", user.email, e);
        userNewsSummaries.push({ user, newsContent: null });
      }
    }

    // Step 4: Send the emails
    await step.run("send-news-emails", async () => {
      await Promise.all(
        userNewsSummaries.map(async ({ user, newsContent }) => {
          console.log(`📧 Preparing to send email to: ${user.email}`);

          if (!newsContent) {
            console.warn(`⚠️ No news content for ${user.email}, skipping...`);
            return false;
          }

          try {
            console.log(
              `➡️ Attempting to send to ${user.email} with content:`,
              newsContent.slice(0, 80) + "..."
            );

            await sendNewsSummaryEmail({
              email: user.email,
              date: getFormattedTodayDate(),
              newsContent,
            });
          } catch (err) {
            console.error(`❌ Failed to send email to ${user.email}:`, err);
          }
        })
      );
    });

    return {
      success: true,
      message: "✅ Daily news summary emails sent successfully",
    };
  }
);
