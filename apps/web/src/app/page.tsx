"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const router = useRouter();
  useEffect(() => router.replace("/command/"), [router]);
  return <main className="min-h-dvh bg-void" />;
}
