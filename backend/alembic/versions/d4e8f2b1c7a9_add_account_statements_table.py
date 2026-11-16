"""add account_statements table

Revision ID: d4e8f2b1c7a9
Revises: b1d84f6a9e02
Create Date: 2026-11-16 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'd4e8f2b1c7a9'
down_revision: Union[str, Sequence[str], None] = 'b1d84f6a9e02'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Append-only, immutable billing snapshots. Additive only — no existing
    # table or column is touched. There is deliberately no updated_at: rows
    # are never modified after insert (see app/services/statement.py).
    op.create_table(
        'account_statements',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            'organization_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('organizations.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('format_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
        sa.Column('content', postgresql.JSON(), nullable=False),
        sa.Column('content_sha256', sa.String(length=64), nullable=False),
        sa.Column('generated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('generated_by_user_id', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        op.f('ix_account_statements_organization_id'),
        'account_statements',
        ['organization_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_account_statements_organization_id'), table_name='account_statements')
    op.drop_table('account_statements')
