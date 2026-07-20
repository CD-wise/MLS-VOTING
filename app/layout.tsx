import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "MLS Voting System",
  description: "Medical Laboratory Science Students Association (MLS) Elections - Accra Technical University",
  generator: 'v0.dev'
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen bg-gradient-to-br from-sky-100 via-sky-200 to-slate-100`}>
        <div className="min-h-screen">
          {children}
        </div>
      </body>
    </html>
  )
}
