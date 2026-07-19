-- Create a function to get transformed student voting data
DROP FUNCTION IF EXISTS get_student_votes_transformed();

CREATE FUNCTION get_student_votes_transformed()
RETURNS TABLE (
  student_id VARCHAR,
  student_name VARCHAR,
  phone VARCHAR,
  email VARCHAR,
  programme VARCHAR,
  level INTEGER,
  presidential VARCHAR,
  financial_secretary VARCHAR,
  general_secretary VARCHAR,
  general_organizers VARCHAR,
  wocom VARCHAR,
  pro VARCHAR,
  health_officer VARCHAR,
  welfare_officer VARCHAR
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.student_id,
    sd.name as student_name,
    sd.phone,
    sd.email,
    sd.programme,
    sd.level,
    MAX(CASE WHEN vc.name = 'Presidential' THEN c.name END) as presidential,
    MAX(CASE WHEN vc.name = 'Financial Secretary' THEN c.name END) as financial_secretary,
    MAX(CASE WHEN vc.name = 'General Secretary' THEN c.name END) as general_secretary,
    MAX(CASE WHEN vc.name = 'General Organizers' THEN c.name END) as general_organizers,
    MAX(CASE WHEN vc.name = 'WOCOM' THEN c.name END) as wocom,
    MAX(CASE WHEN vc.name = 'PRO' THEN c.name END) as pro,
    MAX(CASE WHEN vc.name = 'Health Officer' THEN c.name END) as health_officer,
    MAX(CASE WHEN vc.name = 'Welfare Officer' THEN c.name END) as welfare_officer
  FROM students s
  LEFT JOIN student_details sd ON s.student_id = sd.student_id
  LEFT JOIN votes v ON s.student_id = v.student_id
  LEFT JOIN candidates c ON v.candidate_id = c.id
  LEFT JOIN voting_categories vc ON v.category_id = vc.id
  WHERE s.has_voted = true
  GROUP BY s.student_id, sd.name, sd.phone, sd.email, sd.programme, sd.level
  ORDER BY s.student_id;
END;
$$ LANGUAGE plpgsql;
