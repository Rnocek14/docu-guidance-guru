-- Grant admin role to rnocek14@gmail.com
INSERT INTO public.user_roles (user_id, role)
VALUES ('65c43a0a-7182-448f-9753-ed9818030602', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;