"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { UserManagement } from "@/components/admin/user-management"

export default function AdministrationPage() {
  const { isAdmin, isLoading, user } = useAuth()
  const router = useRouter()
  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) router.replace("/")
  }, [isLoading, user, isAdmin, router])
  if (isLoading || !isAdmin) return null
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-xl font-semibold">Administration — Comptes</h1>
      <UserManagement />
    </div>
  )
}
