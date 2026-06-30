"use client";

// Ask was merged into Search — one surface now does retrieval + synthesis.
// Kept as a redirect so any old bookmark or direct link still lands somewhere.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AskRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/search"); }, [router]);
  return null;
}
