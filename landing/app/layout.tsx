import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Quizzer — Local-first document quizzes',
  description: 'Turn PDFs, notes, and Markdown into source-grounded quizzes with the AI provider you choose.',
  keywords: ['local-first learning', 'quiz generator', 'RAG', 'PDF quiz', 'open source'],
  openGraph: {
    type: 'website',
    title: 'Quizzer — Your documents. Your questions.',
    description: 'Create source-grounded quizzes locally with the AI provider you choose.',
    images: [{ url: 'https://raw.githubusercontent.com/Somethings1/quizzer/main/landing/public/og.png', width: 1200, height: 630, alt: 'Quizzer — Your documents. Your questions.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Quizzer — Your documents. Your questions.',
    description: 'Create source-grounded quizzes locally with the AI provider you choose.',
    images: ['https://raw.githubusercontent.com/Somethings1/quizzer/main/landing/public/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
