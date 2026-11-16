"""plan workspace entitlements + gpu tier columns

Revision ID: f6a3c9d2e1b8
Revises: d4e8f2b1c7a9
Create Date: 2026-11-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'f6a3c9d2e1b8'
down_revision: Union[str, Sequence[str], None] = 'd4e8f2b1c7a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Schema-only migration — all data changes (new plan pricing, the 38-SKU
    # catalogue, tier assignments) happen in scripts/seed.py so they stay
    # re-runnable. Additive only; no existing column is modified or dropped.

    # New plan access level. ALTER TYPE ... ADD VALUE is allowed inside a
    # transaction on Postgres 12+; we do NOT use the value in this migration,
    # so even conservative setups are safe.
    op.execute("ALTER TYPE plancode ADD VALUE IF NOT EXISTS 'ULTRA'")

    # The GPU tier enum + plan/gputype columns.
    # Note: on Postgres, SQLAlchemy emits CREATE TYPE for the native enum.
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE gputier AS ENUM ('STARTER', 'STANDARD', 'PRO', 'ULTRA');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.add_column('plans', sa.Column('included_workspaces', sa.Integer(), nullable=False, server_default=sa.text('1')))
    op.add_column('plans', sa.Column('workspace_storage_gb', sa.Integer(), nullable=False, server_default=sa.text('50')))
    # create_type=False: the gputier type was created explicitly above;
    # letting SQLAlchemy emit its own CREATE TYPE would raise duplicate_object.
    _tier_enum = lambda: postgresql.ENUM(  # noqa: E731
        'STARTER', 'STANDARD', 'PRO', 'ULTRA', name='gputier', create_type=False
    )

    op.add_column(
        'plans',
        sa.Column('gpu_max_tier', _tier_enum(), nullable=False, server_default='STARTER'),
    )

    op.add_column('gpu_types', sa.Column('tier', _tier_enum(), nullable=False, server_default='STARTER'))
    op.add_column('gpu_types', sa.Column('gpu_count', sa.Integer(), nullable=False, server_default=sa.text('1')))
    op.add_column('gpu_types', sa.Column('minimum_rental_hours', sa.Integer(), nullable=False, server_default=sa.text('1')))
    op.add_column('gpu_types', sa.Column('safe_infrastructure_cost_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('gpu_types', 'safe_infrastructure_cost_micros')
    op.drop_column('gpu_types', 'minimum_rental_hours')
    op.drop_column('gpu_types', 'gpu_count')
    op.drop_column('gpu_types', 'tier')
    op.drop_column('plans', 'gpu_max_tier')
    op.drop_column('plans', 'workspace_storage_gb')
    op.drop_column('plans', 'included_workspaces')
    # Enum value/type removal is intentionally omitted: ALTER TYPE DROP is not
    # supported for enum values, and dropping gputier would break dependent
    # columns. Downgrade restores the schema to column parity only.
