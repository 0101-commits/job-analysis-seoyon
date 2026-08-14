export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          detail: Json
          id: string
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: []
      }
      companies: {
        Row: {
          code: string
          created_at: string
          id: string
          name: string
          status: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          name: string
          status?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          name?: string
          status?: string
        }
        Relationships: []
      }
      example_library: {
        Row: {
          bad_example: string | null
          category: string
          field: string
          good_example: string
          id: string
          note: string | null
          sort: number
        }
        Insert: {
          bad_example?: string | null
          category: string
          field: string
          good_example: string
          id?: string
          note?: string | null
          sort?: number
        }
        Update: {
          bad_example?: string | null
          category?: string
          field?: string
          good_example?: string
          id?: string
          note?: string | null
          sort?: number
        }
        Relationships: []
      }
      mail_batches: {
        Row: {
          company_id: string | null
          created_at: string
          created_by: string | null
          failed_count: number
          filters: Json
          finished_at: string | null
          id: string
          name: string
          scheduled_at: string | null
          sent_count: number
          simulated: boolean
          started_at: string | null
          status: string
          template_id: string | null
          total_count: number
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          filters?: Json
          finished_at?: string | null
          id?: string
          name: string
          scheduled_at?: string | null
          sent_count?: number
          simulated?: boolean
          started_at?: string | null
          status?: string
          template_id?: string | null
          total_count?: number
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          filters?: Json
          finished_at?: string | null
          id?: string
          name?: string
          scheduled_at?: string | null
          sent_count?: number
          simulated?: boolean
          started_at?: string | null
          status?: string
          template_id?: string | null
          total_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_batches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mail_batches_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "mail_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      mail_logs: {
        Row: {
          batch_id: string | null
          body: string
          error_message: string | null
          id: string
          participant_id: string | null
          provider_id: string | null
          sent_at: string
          status: string
          subject: string
          template_id: string | null
          to_email: string
          to_name: string | null
        }
        Insert: {
          batch_id?: string | null
          body: string
          error_message?: string | null
          id?: string
          participant_id?: string | null
          provider_id?: string | null
          sent_at?: string
          status: string
          subject: string
          template_id?: string | null
          to_email: string
          to_name?: string | null
        }
        Update: {
          batch_id?: string | null
          body?: string
          error_message?: string | null
          id?: string
          participant_id?: string | null
          provider_id?: string | null
          sent_at?: string
          status?: string
          subject?: string
          template_id?: string | null
          to_email?: string
          to_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mail_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mail_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mail_logs_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mail_logs_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "mail_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      mail_templates: {
        Row: {
          body: string
          created_at: string
          id: string
          is_default: boolean
          kind: string
          name: string
          subject: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_default?: boolean
          kind?: string
          name: string
          subject: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_default?: boolean
          kind?: string
          name?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      participants: {
        Row: {
          account_status: Database["public"]["Enums"]["account_status"]
          birth_date: string | null
          company_id: string
          created_at: string
          email: string | null
          emp_no: string
          failed_login_count: number
          first_login_at: string | null
          grade: string | null
          id: string
          initial_password: string | null
          invited_at: string | null
          last_seen_at: string | null
          locked_until: string | null
          must_change_password: boolean
          name: string
          org_text: string | null
          role: Database["public"]["Enums"]["app_role"]
          role_level: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_status?: Database["public"]["Enums"]["account_status"]
          birth_date?: string | null
          company_id: string
          created_at?: string
          email?: string | null
          emp_no: string
          failed_login_count?: number
          first_login_at?: string | null
          grade?: string | null
          id?: string
          initial_password?: string | null
          invited_at?: string | null
          last_seen_at?: string | null
          locked_until?: string | null
          must_change_password?: boolean
          name: string
          org_text?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          role_level?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_status?: Database["public"]["Enums"]["account_status"]
          birth_date?: string | null
          company_id?: string
          created_at?: string
          email?: string | null
          emp_no?: string
          failed_login_count?: number
          first_login_at?: string | null
          grade?: string | null
          id?: string
          initial_password?: string | null
          invited_at?: string | null
          last_seen_at?: string | null
          locked_until?: string | null
          must_change_password?: boolean
          name?: string
          org_text?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          role_level?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "participants_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      response_activities: {
        Row: {
          id: string
          name: string
          seq: number
          task_id: string
        }
        Insert: {
          id?: string
          name: string
          seq?: number
          task_id: string
        }
        Update: {
          id?: string
          name?: string
          seq?: number
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "response_activities_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "response_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      response_requirements: {
        Row: {
          ai_draft: boolean
          education: string | null
          id: string
          languages: Json
          licenses: Json
          majors_preferred: string | null
          majors_required: string | null
          proficiency: string | null
          response_id: string
          trainings: string | null
        }
        Insert: {
          ai_draft?: boolean
          education?: string | null
          id?: string
          languages?: Json
          licenses?: Json
          majors_preferred?: string | null
          majors_required?: string | null
          proficiency?: string | null
          response_id: string
          trainings?: string | null
        }
        Update: {
          ai_draft?: boolean
          education?: string | null
          id?: string
          languages?: Json
          licenses?: Json
          majors_preferred?: string | null
          majors_required?: string | null
          proficiency?: string | null
          response_id?: string
          trainings?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "response_requirements_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: true
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
        ]
      }
      response_skills: {
        Row: {
          ai_draft: boolean
          description: string | null
          hard_soft: string | null
          id: string
          ksao: string | null
          name: string
          related_task_ids: string[]
          response_id: string
        }
        Insert: {
          ai_draft?: boolean
          description?: string | null
          hard_soft?: string | null
          id?: string
          ksao?: string | null
          name: string
          related_task_ids?: string[]
          response_id: string
        }
        Update: {
          ai_draft?: boolean
          description?: string | null
          hard_soft?: string | null
          id?: string
          ksao?: string | null
          name?: string
          related_task_ids?: string[]
          response_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "response_skills_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: false
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
        ]
      }
      response_tasks: {
        Row: {
          authority: string | null
          id: string
          importance: number | null
          improve_note: string | null
          improve_type: string | null
          is_key: boolean
          name: string
          response_id: string
          seq: number
          transferable: boolean | null
        }
        Insert: {
          authority?: string | null
          id?: string
          importance?: number | null
          improve_note?: string | null
          improve_type?: string | null
          is_key?: boolean
          name: string
          response_id: string
          seq?: number
          transferable?: boolean | null
        }
        Update: {
          authority?: string | null
          id?: string
          importance?: number | null
          improve_note?: string | null
          improve_type?: string | null
          is_key?: boolean
          name?: string
          response_id?: string
          seq?: number
          transferable?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "response_tasks_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: false
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
        ]
      }
      responses: {
        Row: {
          company_id: string
          coverage_pct: string | null
          created_at: string
          current_step: number
          definition: string | null
          id: string
          job_group: string | null
          job_name: string | null
          job_series: string | null
          mission: string | null
          missed_note: string | null
          onboarding_done: boolean
          pain_note: string | null
          participant_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          coverage_pct?: string | null
          created_at?: string
          current_step?: number
          definition?: string | null
          id?: string
          job_group?: string | null
          job_name?: string | null
          job_series?: string | null
          mission?: string | null
          missed_note?: string | null
          onboarding_done?: boolean
          pain_note?: string | null
          participant_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          coverage_pct?: string | null
          created_at?: string
          current_step?: number
          definition?: string | null
          id?: string
          job_group?: string | null
          job_name?: string | null
          job_series?: string | null
          mission?: string | null
          missed_note?: string | null
          onboarding_done?: boolean
          pain_note?: string | null
          participant_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "responses_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "responses_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: true
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
        ]
      }
      review_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          kind: string
          response_id: string
          step: number | null
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          kind?: string
          response_id: string
          step?: number | null
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          kind?: string
          response_id?: string
          step?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "review_comments_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: false
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
        ]
      }
      survey_settings: {
        Row: {
          company_id: string
          created_at: string
          deadline: string | null
          reminder_auto: boolean
          reminder_days: number[]
          reminder_target: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          deadline?: string | null
          reminder_auto?: boolean
          reminder_days?: number[]
          reminder_target?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          deadline?: string | null
          reminder_auto?: boolean
          reminder_days?: number[]
          reminder_target?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "survey_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          created_at: string
          id: boolean
          password_rule: string
          role_levels: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: boolean
          password_rule?: string
          role_levels?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: boolean
          password_rule?: string
          role_levels?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      job_suggestions: {
        Args: { _company_id: string }
        Returns: {
          job_group: string | null
          job_series: string | null
          job_name: string | null
        }[]
      }
      link_current_user: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      owns_response: {
        Args: { _editable?: boolean; _response_id: string }
        Returns: boolean
      }
      owns_task: {
        Args: { _editable?: boolean; _task_id: string }
        Returns: boolean
      }
    }
    Enums: {
      account_status:
        | "미발송"
        | "초대발송"
        | "미접속"
        | "작성중"
        | "제출"
        | "반려"
        | "승인"
      app_role: "respondent" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: [
        "미발송",
        "초대발송",
        "미접속",
        "작성중",
        "제출",
        "반려",
        "승인",
      ],
      app_role: ["respondent", "admin"],
    },
  },
} as const
