'use client';
import { ChatView } from '@/components/chat-view';

export default function HomePage() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Ask your policy</h1>
      <ChatView />
    </section>
  );
}
