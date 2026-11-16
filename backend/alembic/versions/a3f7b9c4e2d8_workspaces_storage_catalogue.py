"""workspaces + persistent storage catalogue

Revision ID: a3f7b9c4e2d8
Revises: f6a3c9d2e1b8
Create Date: 2026-11-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a3f7b9c4e2d8'
down_revision: Union[str, Sequence[str], None] = 'f6a3c9d2e1b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Additive only, matching f6a3c9d2e1b8: catalogue/pricing data changes
    # happen in scripts/seed.py so they stay re-runnable.

    # New enum types, created explicitly (same duplicate_object-safe pattern
    # as f6a3c9d2e1b8) so the create_type=False columns below are safe.
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE workspacestatus AS ENUM ('ACTIVE', 'DELETED');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE storagebillingmode AS ENUM ('HOURLY', 'PREPAID_30D');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)

    _ws_status = lambda: postgresql.ENUM(  # noqa: E731
        'ACTIVE', 'DELETED', name='workspacestatus', create_type=False
    )
    _billing_mode = lambda: postgresql.ENUM(  # noqa: E731
        'HOURLY', 'PREPAID_30D', name='storagebillingmode', create_type=False
    )

    op.create_table(
        'storage_sizes',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('size_gb', sa.Integer(), nullable=False),
        sa.Column('display_name', sa.String(length=50), nullable=False),
        sa.Column('hourly_price_micros', sa.BigInteger(), nullable=False),
        sa.Column('prepaid_price_micros', sa.BigInteger(), nullable=False),
        sa.Column('available_plans', sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )
    op.create_index('ix_storage_sizes_size_gb', 'storage_sizes', ['size_gb'], unique=True)

    op.create_table(
        'workspaces',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_by_user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('storage_size_gb', sa.Integer(), nullable=False),
        sa.Column('storage_volume_id', sa.String(length=100), nullable=True),
        sa.Column('ssh_key_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('billing_mode', _billing_mode(), nullable=False, server_default='HOURLY'),
        sa.Column('prepaid_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', _ws_status(), nullable=False, server_default='ACTIVE'),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('hourly_rate_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('last_billed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('total_charged_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('payment_overdue_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['ssh_key_id'], ['ssh_keys.id']),
    )
    op.create_index('ix_workspaces_organization_id', 'workspaces', ['organization_id'])
    op.create_index('ix_workspaces_status', 'workspaces', ['status'])

    # Ledger: storage transaction types + traceability link.
    # ALTER TYPE ... ADD VALUE is allowed inside a transaction on Postgres 12+
    # as long as the new values are not used within the same transaction.
    op.execute("ALTER TYPE credittransactiontype ADD VALUE IF NOT EXISTS 'STORAGE_USAGE'")
    op.execute("ALTER TYPE credittransactiontype ADD VALUE IF NOT EXISTS 'STORAGE_PREPAID'")
    op.add_column('credit_transactions', sa.Column('workspace_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index('ix_credit_transactions_workspace_id', 'credit_transactions', ['workspace_id'])

    # GPU rentals reference (never own) a workspace (spec §22).
    op.add_column('gpu_instances', sa.Column('workspace_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        'fk_gpu_instances_workspace_id', 'gpu_instances', 'workspaces', ['workspace_id'], ['id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_gpu_instances_workspace_id', 'gpu_instances', type_='foreignkey')
    op.drop_column('gpu_instances', 'workspace_id')
    op.drop_index('ix_credit_transactions_workspace_id', table_name='credit_transactions')
    op.drop_column('credit_transactions', 'workspace_id')
    op.drop_index('ix_workspaces_status', table_name='workspaces')
    op.drop_index('ix_workspaces_organization_id', table_name='workspaces')
    op.drop_table('workspaces')
    op.drop_index('ix_storage_sizes_size_gb', table_name='storage_sizes')
    op.drop_table('storage_sizes')
    # Credittransactiontype values (STORAGE_USAGE / STORAGE_PREPAID) are
    # intentionally not removed: ALTER TYPE DROP VALUE is unsupported, and the
    # ledger must stay append-only anyway.
    op.execute("DROP TYPE IF EXISTS workspacestatus")
    op.execute("DROP TYPE IF EXISTS storagebillingmode")
