export type UserType = 'User' | 'Staff' | 'Admin';

export interface UserProfile {
  user_id: string;
  user_name: string | null;
  email: string | null;
  profile_picture_url: string | null;
  user_type: UserType;
  notification_token: string | null;
}

export interface AuthLoginRequest {
  googleIdToken: string;
}

export interface AuthLoginResponse {
  token: string;
  user: UserProfile;
}

export interface AuthMeResponse {
  user: UserProfile;
}

export interface UpdateProfileRequest {
  notification_token?: string | null;
  user_name?: string | null;
  profile_picture_url?: string | null;
}

export interface UpdateProfileResponse {
  user: UserProfile;
}

export interface JwtPayload {
  user_id: string;
  email: string | null;
  user_type: UserType;
  iat?: number;
  exp?: number;
}

export interface UserSearchResponse {
  results: UserProfile[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}
