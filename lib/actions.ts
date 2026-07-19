"use server"

import { supabase } from "./supabase"
import { sendSMSOTP, maskPhoneNumber } from "./mnotify-sms"

// Canonical normalization used everywhere a student_id is read or written.
// Your data is stored UPPERCASE (e.g. "01240715B"), and Postgres varchar
// comparisons are case-sensitive, so every lookup and insert must use the
// same case or rows will silently fail to match.
function normalizeStudentId(studentId: string) {
  return studentId.toUpperCase().trim().replace(/\s+/g, "")
}

async function findStudentRecord(
  studentId: string,
  table: "students" | "student_details",
  selectColumns: string,
) {
  const normalizedStudentId = normalizeStudentId(studentId)

  // Filter in the database with .eq() + .maybeSingle() instead of fetching
  // the whole table and searching client-side. The old approach relied on
  // supabase.from(table).select(...) with no filter, which is capped at
  // 1000 rows by PostgREST by default — any student outside that first
  // batch would never be found. This also uses the student_id index.
  const { data, error } = await supabase
    .from(table)
    .select(selectColumns)
    .eq("student_id", normalizedStudentId)
    .maybeSingle()

  if (error) {
    console.error(`${table} lookup error:`, error)
    return null
  }

  return data
}

async function getStudentRecordWithFallback(studentId: string) {
  const student = await findStudentRecord(
    studentId,
    "students",
    "student_id, name, phone, programme, level, has_voted",
  )

  if (!student) {
    return null
  }

  const fallbackStudent = await findStudentRecord(
    studentId,
    "student_details",
    "name, phone, programme, level",
  )

  return {
    ...student,
    name: student.name || fallbackStudent?.name || "",
    phone: student.phone || fallbackStudent?.phone || "",
    programme: student.programme || fallbackStudent?.programme || "",
    level: student.level || fallbackStudent?.level || "",
  }
}

export async function verifyStudentId(studentId: string) {
  try {
    const student = await getStudentRecordWithFallback(studentId)

    if (!student) {
      return { success: false, message: "Student ID not found. Please check your ID and try again." }
    }

    if (student.has_voted) {
      return { success: false, message: "You have already voted in this election." }
    }

    const missingFields = [
      !student.name ? "name" : null,
      !student.phone ? "phone number" : null,
      !student.programme ? "programme" : null,
      !student.level ? "level" : null,
    ].filter(Boolean)

    if (missingFields.length > 0) {
      return {
        success: false,
        message: `Your student record is missing: ${missingFields.join(", ")}. Please contact the administrator.`,
      }
    }

    return {
      success: true,
      student: {
        student_id: student.student_id,
        name: student.name,
        phone: student.phone,
        programme: student.programme,
        level: student.level,
      },
      maskedPhone: maskPhoneNumber(student.phone),
    }
  } catch (error) {
    console.error('Error in verifyStudentId:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function verifyPhoneNumber(studentId: string, phoneNumber: string) {
  try {
    const student = await getStudentRecordWithFallback(studentId)

    if (!student) {
      return { success: false, message: "Student not found." }
    }

    // Clean phone numbers for comparison (remove spaces, dashes, parentheses)
    const cleanInputPhone = phoneNumber.replace(/[\s\-()]/g, '').trim()
    const cleanStoredPhone = student.phone.replace(/[\s\-()]/g, '').trim()

    if (cleanInputPhone !== cleanStoredPhone) {
      return { success: false, message: "Phone number does not match our records. Please check and try again." }
    }

    return { success: true }
  } catch (error) {
    console.error('Error in verifyPhoneNumber:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function generateSMSOTP(studentId: string) {
  try {
    const cleanStudentId = normalizeStudentId(studentId)
    console.log('Generating OTP for student:', cleanStudentId)

    // First, invalidate any existing unused OTPs for this student
    const { error: invalidateError } = await supabase
      .from("sms_otps")
      .update({ used: true })
      .eq("student_id", cleanStudentId)
      .eq("used", false)

    if (invalidateError) {
      console.error('Error invalidating old OTPs:', invalidateError)
    }

    // Check for recent OTP requests (within last 2 minutes)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
    const { data: recentOTPs, error: recentError } = await supabase
      .from("sms_otps")
      .select("created_at")
      .eq("student_id", cleanStudentId)
      .gt("created_at", twoMinutesAgo.toISOString())
      .order("created_at", { ascending: false })

    if (recentError) {
      console.error('Error checking recent OTPs:', recentError)
    }

    if (recentOTPs && recentOTPs.length > 0) {
      const lastOTPTime = new Date(recentOTPs[0].created_at)
      const timeDiff = Math.ceil((Date.now() - lastOTPTime.getTime()) / 1000)
      const waitTime = 120 - timeDiff // 2 minutes = 120 seconds

      if (waitTime > 0) {
        console.log('Rate limit hit, wait time:', waitTime)
        return {
          success: false,
          message: `Please wait ${waitTime} seconds before requesting another OTP.`
        }
      }
    }

    // Check for too many OTP requests in the last hour (max 3)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const { data: hourlyOTPs, error: hourlyError } = await supabase
      .from("sms_otps")
      .select("id")
      .eq("student_id", cleanStudentId)
      .gt("created_at", oneHourAgo.toISOString())

    if (hourlyError) {
      console.error('Error checking hourly OTPs:', hourlyError)
    }

    if (hourlyOTPs && hourlyOTPs.length >= 3) {
      console.log('Hourly limit exceeded')
      return {
        success: false,
        message: "Too many OTP requests. Please try again after 1 hour or contact support."
      }
    }

    const student = await getStudentRecordWithFallback(cleanStudentId)

    if (!student) {
      return { success: false, message: "Student not found." }
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now

    console.log('Generated OTP:', otp, 'for phone:', student.phone)

    // Store OTP in database FIRST
    const { data: otpData, error: otpError } = await supabase
      .from("sms_otps")
      .insert({
        student_id: cleanStudentId,
        phone: student.phone,
        otp_code: otp,
        expires_at: expiresAt.toISOString(),
      })
      .select()

    if (otpError) {
      console.error('Error storing OTP:', otpError)
      return { success: false, message: "Failed to generate verification code. Please try again." }
    }

    console.log('OTP stored in database:', otpData)

    // Send SMS only after successful database storage
    const smsResult = await sendSMSOTP(student.phone, otp)

    if (!smsResult.success) {
      console.error('SMS sending failed, marking OTP as used')
      // Mark the OTP as used since SMS failed
      await supabase
        .from("sms_otps")
        .update({ used: true })
        .eq("student_id", cleanStudentId)
        .eq("otp_code", otp)

      return { success: false, message: "Failed to send SMS verification code. Please try again." }
    }

    console.log('SMS sent successfully')
    return { success: true, message: "Verification code sent to your phone number." }
  } catch (error) {
    console.error('Error in generateSMSOTP:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function verifySMSOTP(studentId: string, otpCode: string) {
  try {
    const { data: otpRecords, error } = await supabase
      .from("sms_otps")
      .select("*")
      .eq("student_id", normalizeStudentId(studentId))
      .eq("otp_code", otpCode.trim())
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)

    if (error || !otpRecords || otpRecords.length === 0) {
      return { success: false, message: "Invalid or expired verification code. Please try again." }
    }

    const otpRecord = otpRecords[0]

    // Mark OTP as used
    const { error: updateError } = await supabase
      .from("sms_otps")
      .update({ used: true })
      .eq("id", otpRecord.id)

    if (updateError) {
      console.error('Error updating OTP:', updateError)
      return { success: false, message: "Failed to verify code. Please try again." }
    }

    return { success: true }
  } catch (error) {
    console.error('Error in verifySMSOTP:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function getStudentDetails(studentId: string) {
  try {
    const { data: student, error } = await supabase
      .from("students")
      .select("name, programme, level")
      .eq("student_id", normalizeStudentId(studentId))
      .maybeSingle()

    if (error || !student) {
      return { success: false, message: "Student not found." }
    }

    return {
      success: true,
      student: {
        name: student.name,
        programme: student.programme,
        level: student.level
      }
    }
  } catch (error) {
    console.error('Error in getStudentDetails:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function checkEmailAvailability(email: string) {
  try {
    const { data: existingEmail, error } = await supabase
      .from("student_details")
      .select("email")
      .eq("email", email.toLowerCase().trim())
      .maybeSingle()

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found" error, which means email is available
      console.error('Error checking email:', error)
      return { success: false, message: "Error checking email availability. Please try again." }
    }

    if (existingEmail) {
      return { success: false, message: "This email address has already been used by another student." }
    }

    return { success: true, message: "Email is available." }
  } catch (error) {
    console.error('Error in checkEmailAvailability:', error)
    return { success: false, message: "Error checking email availability. Please try again." }
  }
}

export async function saveStudentDetails(studentId: string, email: string) {
  try {
    const cleanStudentId = normalizeStudentId(studentId)
    console.log('Saving student details for:', cleanStudentId, 'with email:', email)

    // First check if email is already used
    const emailCheck = await checkEmailAvailability(email)
    if (!emailCheck.success) {
      console.log('Email check failed:', emailCheck.message)
      return emailCheck
    }

    // Get student info from students table
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("name, phone, programme, level")
      .eq("student_id", cleanStudentId)
      .maybeSingle()

    if (studentError || !student) {
      console.log('Student not found:', studentError)
      return { success: false, message: "Student not found." }
    }

    console.log('Found student:', student)

    const safeProgramme = student.programme?.trim() || "Medical Laboratory Science"
    const safeLevel = student.level != null && student.level !== ""
      ? String(student.level).trim()
      : "100"

    // Insert student details
    const { data: insertData, error } = await supabase.from("student_details").insert({
      student_id: cleanStudentId,
      name: student.name?.trim() || "",
      phone: student.phone?.trim() || "",
      programme: safeProgramme,
      level: safeLevel,
      email: email.toLowerCase().trim(),
    })

    if (error) {
      console.error('Error saving student details:', error)
      const errorMessage = typeof error.message === "string" ? error.message : ""

      // Check if it's a unique constraint violation
      if (error.code === "23505") {
        if (errorMessage.includes("unique_student_email")) {
          return { success: false, message: "This email address has already been used by another student." }
        }
        if (errorMessage.includes("student_details_pkey")) {
          return { success: false, message: "You have already completed your details." }
        }
      }

      if (error.code === "23514" || errorMessage.includes("check constraint") || errorMessage.includes("violates")) {
        return {
          success: false,
          message: "The student details table is still using old validation rules. Please run the database schema update script before continuing.",
        }
      }

      return { success: false, message: "Failed to save student details. Please try again." }
    }

    console.log('Student details saved successfully:', insertData)
    return { success: true }
  } catch (error) {
    console.error('Error in saveStudentDetails:', error)
    return { success: false, message: "An error occurred. Please try again." }
  }
}

export async function getVotingData() {
  try {
    console.log('Getting voting data...')

    // Check if voting is open
    const { data: votingStatus, error: statusError } = await supabase
      .from("voting_status")
      .select("is_open")
      .eq("id", 1)

    if (statusError) {
      console.error('Error getting voting status:', statusError)
    }

    const { data: categories, error: categoriesError } = await supabase
      .from("voting_categories")
      .select("*")
      .order("display_order")

    if (categoriesError) {
      console.error('Error getting categories:', categoriesError)
    }

    const { data: candidates, error: candidatesError } = await supabase
      .from("candidates")
      .select("*")

    if (candidatesError) {
      console.error('Error getting candidates:', candidatesError)
    }

    const normalizedCategories = (categories || []).filter((category, index, array) => {
      const normalizedName = (category.name || "").trim().toLowerCase()
      return array.findIndex((item) => (item.name || "").trim().toLowerCase() === normalizedName) === index
    })

    const validCategoryIds = new Set(normalizedCategories.map((category) => category.id))
    const normalizedCandidates = (candidates || []).filter((candidate) => {
      return candidate.category_id && validCategoryIds.has(candidate.category_id)
    })

    const orderedCategories = [...normalizedCategories].sort((a, b) => {
      return (a.display_order ?? 0) - (b.display_order ?? 0) || a.id - b.id
    })

    const orderedCandidates = [...normalizedCandidates].sort((a, b) => a.id - b.id)

    console.log('Voting data retrieved:', {
      categories: orderedCategories.length,
      candidates: orderedCandidates.length,
      votingOpen: votingStatus && votingStatus.length > 0 ? votingStatus[0].is_open : true
    })

    return {
      categories: orderedCategories,
      candidates: orderedCandidates,
      votingOpen: votingStatus && votingStatus.length > 0 ? votingStatus[0].is_open : true
    }
  } catch (error) {
    console.error('Error in getVotingData:', error)
    return {
      categories: [],
      candidates: [],
      votingOpen: true
    }
  }
}

export async function submitVote(studentId: string, candidateId: number, categoryId: number) {
  try {
    console.log('Submitting vote:', { studentId, candidateId, categoryId })

    if (!studentId || !candidateId || !categoryId) {
      console.error('Missing required parameters for vote submission')
      return { success: false, message: "Missing required information for voting." }
    }

    const cleanStudentId = normalizeStudentId(studentId)

    // Check if student has already voted in this category
    const { data: existingVotes, error: checkError } = await supabase
      .from("votes")
      .select("*")
      .eq("student_id", cleanStudentId)
      .eq("category_id", categoryId)

    if (checkError) {
      console.error('Error checking existing votes:', checkError)
      return { success: false, message: "Error checking existing votes. Please try again." }
    }

    if (existingVotes && existingVotes.length > 0) {
      console.log('Student has already voted in this category')
      return { success: false, message: "You have already voted in this category." }
    }

    // Insert the vote
    const { data: voteData, error: insertError } = await supabase
      .from("votes")
      .insert({
        student_id: cleanStudentId,
        candidate_id: candidateId,
        category_id: categoryId,
      })
      .select()

    if (insertError) {
      console.error('Error inserting vote:', insertError)
      return { success: false, message: "Failed to submit vote. Please try again." }
    }

    console.log('Vote submitted successfully:', voteData)
    return { success: true }
  } catch (error) {
    console.error('Error in submitVote:', error)
    return { success: false, message: "An error occurred while submitting your vote. Please try again." }
  }
}

export async function markStudentAsVoted(studentId: string) {
  try {
    console.log('Marking student as voted:', studentId)

    const { data, error } = await supabase
      .from("students")
      .update({ has_voted: true })
      .eq("student_id", normalizeStudentId(studentId))
      .select()

    if (error) {
      console.error('Error marking student as voted:', error)
      return { success: false }
    }

    console.log('Student marked as voted successfully:', data)
    return { success: true }
  } catch (error) {
    console.error('Error in markStudentAsVoted:', error)
    return { success: false }
  }
}

export async function getStudentVotes(studentId: string) {
  try {
    console.log('Getting student votes for:', studentId)

    const { data: votes, error } = await supabase
      .from("votes")
      .select("category_id")
      .eq("student_id", normalizeStudentId(studentId))

    if (error) {
      console.error('Error getting student votes:', error)
      return []
    }

    const categoryIds = votes?.map((vote) => vote.category_id) || []
    console.log('Student votes found:', categoryIds)

    return categoryIds
  } catch (error) {
    console.error('Error in getStudentVotes:', error)
    return []
  }
}