CREATE OR REPLACE FUNCTION public.link_current_user()
RETURNS public.app_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_role public.app_role;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT lower(email) INTO v_email FROM auth.users WHERE id = v_uid;

  UPDATE public.participants
     SET user_id = v_uid,
         first_login_at = COALESCE(first_login_at, now()),
         last_seen_at = now(),
         account_status = CASE WHEN account_status IN ('미발송','초대발송','미접속')
                               THEN '미접속'::public.account_status ELSE account_status END
   WHERE lower(email) = v_email
     AND (user_id IS NULL OR user_id = v_uid)
   RETURNING role INTO v_role;

  IF v_role IS NULL THEN
    SELECT role INTO v_role FROM public.participants WHERE user_id = v_uid LIMIT 1;
  END IF;

  IF v_role IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (v_uid, v_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  RETURN v_role;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.link_current_user() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.link_current_user() TO authenticated;
